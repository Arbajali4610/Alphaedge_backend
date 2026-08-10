const express = require('express');
const protobuf = require('protobufjs');
const WebSocket = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 10000;
const ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const configured = process.env.FRONTEND_ORIGIN;
  const allowed = !origin || origin === 'null' ||
    (configured && origin === configured) ||
    origin === 'https://alphaedge-c3yf.onrender.com' ||
    origin === 'https://alphaedge-live.onrender.com' ||
    /^https:\/\/[^/]+\.github\.io$/.test(origin) ||
    /^http:\/\/localhost(?::\d+)?$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* =========================
DATABASE
========================= */

let pool = null;
let databaseReady = false;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
  });
}

async function initDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL is not configured. Authentication is disabled.');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id BIGSERIAL PRIMARY KEY,
        client_id VARCHAR(30) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payment_confirmations (
        id BIGSERIAL PRIMARY KEY,
        client_id VARCHAR(30) NOT NULL
          REFERENCES clients(client_id) ON DELETE CASCADE,
        course VARCHAR(120) NOT NULL,
        amount NUMERIC(10,2) NOT NULL DEFAULT 999.00,
        utr VARCHAR(100) NOT NULL,
        slip_name VARCHAR(255),
        slip_data TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id BIGSERIAL PRIMARY KEY,
        symbol VARCHAR(30) NOT NULL,
        ltp NUMERIC(14,4) NOT NULL,
        close NUMERIC(14,4),
        change_pct NUMERIC(10,4),
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS market_snapshots_symbol_time_idx
      ON market_snapshots(symbol, captured_at DESC);
    `);

    databaseReady = true;
    console.log('PostgreSQL database ready.');

  } catch (err) {
    databaseReady = false;
    console.error(
      'PostgreSQL initialization failed:',
      err.message
    );
  }
}

/* =========================
SESSION
========================= */

if (pool) {
  app.use(
    session({
      store: new pgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
      }),

      secret:
        process.env.SESSION_SECRET ||
        'CHANGE_THIS_SESSION_SECRET',

      resave: false,
      saveUninitialized: false,

      cookie: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: null
      }
    })
  );
} else {
  app.use(
    session({
      secret:
        process.env.SESSION_SECRET ||
        'CHANGE_THIS_SESSION_SECRET',

      resave: false,
      saveUninitialized: false
    })
  );
}

/* =========================
MARKET DATA
========================= */

const INSTRUMENTS = {
  nifty: 'NSE_INDEX|Nifty 50',
  sensex: 'BSE_INDEX|SENSEX',
  banknifty: 'NSE_INDEX|Nifty Bank',
  reliance: 'NSE_EQ|INE002A01018',
  tcs: 'NSE_EQ|INE467B01029',
  hdfcbank: 'NSE_EQ|INE040A01034',
  icicibank: 'NSE_EQ|INE090A01021',
  sbin: 'NSE_EQ|INE062A01020',
  airtel: 'NSE_EQ|INE397D01024',
  lt: 'NSE_EQ|INE018A01030',
  axisbank: 'NSE_EQ|INE238A01034',
  kotakbank: 'NSE_EQ|INE237A01036'
};
const INSTRUMENT_NAMES = Object.fromEntries(Object.entries(INSTRUMENTS).map(([name,key]) => [key,name]));

let latest = {
  ...Object.fromEntries(Object.keys(INSTRUMENTS).map(name => [name, null])),
  connected: false,
  updatedAt: null,
  error: ACCESS_TOKEN ? null : 'UPSTOX_ACCESS_TOKEN is not configured'
};

async function saveMarketSnapshot(name, value) {
  if (!pool || !databaseReady || !value) return;

  try {
    await pool.query(
      `INSERT INTO market_snapshots
       (symbol, ltp, close, change_pct)
       VALUES ($1, $2, $3, $4)`,
      [
        name,
        value.ltp,
        value.close,
        value.changePct
      ]
    );

  } catch (err) {
    console.error(
      'Market snapshot save failed:',
      err.message
    );
  }
}

const clients = new Set();

app.use(express.static(__dirname));

app.get('/api/market', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(latest);
});

app.get('/api/market/history', async (req, res) => {

  if (!pool || !databaseReady) {
    return res.json({
      success: true,
      history: []
    });
  }

  const symbol =
    String(req.query.symbol || 'nifty')
      .toLowerCase();

  const allowed = [
    'nifty',
    'sensex',
    'banknifty'
  ];

  if (!allowed.includes(symbol)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid symbol'
    });
  }

  try {

    const result = await pool.query(
      `SELECT
        ltp,
        close,
        change_pct,
        captured_at
       FROM market_snapshots
       WHERE symbol = $1
       ORDER BY captured_at DESC
       LIMIT 120`,
      [symbol]
    );

    res.set(
      'Cache-Control',
      'no-store'
    );

    res.json({
      success: true,
      history: result.rows.reverse()
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      message: 'Unable to load market history'
    });
  }
});

app.get('/api/market/history-v3', async (req, res) => {
  const symbol = String(req.query.symbol || 'nifty').toLowerCase();
  const range = String(req.query.range || '5y').toLowerCase();
  const instrumentKey = INSTRUMENTS[symbol];
  const years = range === '1y' ? 1 : range === '3y' ? 3 : range === '5y' ? 5 : null;

  if (!instrumentKey || !years) {
    return res.status(400).json({ success: false, message: 'Invalid chart symbol or range' });
  }
  if (!ACCESS_TOKEN) {
    return res.status(503).json({ success: false, message: 'Live market data is not configured' });
  }

  try {
    const now = new Date();
    const toDate = now.toISOString().slice(0, 10);
    const from = new Date(now);
    from.setUTCFullYear(from.getUTCFullYear() - years);
    const fromDate = from.toISOString().slice(0, 10);
    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/days/1/${toDate}/${fromDate}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ success: false, message: response.status === 401 ? 'Upstox access token expired or invalid' : 'Historical market data unavailable' });
    }
    const candles = Array.isArray(body?.data?.candles) ? body.data.candles : [];
    const history = candles.map(c => ({
      date: c[0], open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5])
    })).filter(c => Number.isFinite(c.close)).reverse();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, symbol, range, history });
  } catch (err) {
    console.error('Historical market data error:', err.message);
    return res.status(502).json({ success: false, message: 'Historical market data unavailable' });
  }
});


/* =========================
EQUITY HUB — UPSTOX REST PROXY
The browser must not call Yahoo directly. Use the server-side Upstox token
for quotes and historical candles so Equity Hub uses the same data source as
Dashboard/Watchlist and avoids browser CORS/provider failures.
========================= */

function validInstrumentKey(key) {
  return typeof key === 'string' &&
    /^(NSE_EQ|BSE_EQ|NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9._:-]+$/.test(key);
}

app.get('/api/equity/quotes', async (req, res) => {
  if (!ACCESS_TOKEN) {
    return res.status(503).json({ success: false, message: 'Live market data is not configured' });
  }

  const keys = String(req.query.instrument_key || '')
    .split(',')
    .map(v => decodeURIComponent(v).trim())
    .filter(validInstrumentKey);

  if (!keys.length) {
    return res.status(400).json({ success: false, message: 'instrument_key is required' });
  }
  if (keys.length > 500) {
    return res.status(400).json({ success: false, message: 'Maximum 500 instruments per request' });
  }

  try {
    const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(','))}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`
      }
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: response.status === 401 ? 'Upstox access token expired or invalid' : 'Unable to load equity quotes'
      });
    }

    const quotes = {};
    for (const [token, q] of Object.entries(body?.data || {})) {
      const price = Number(q?.last_price);
      const close = Number(q?.cp);
      if (!Number.isFinite(price)) continue;
      quotes[token] = {
        price,
        close: Number.isFinite(close) ? close : null,
        changePct: Number.isFinite(close) && close !== 0 ? ((price - close) / close) * 100 : null,
        volume: Number(q?.volume) || 0,
        ltq: Number(q?.ltq) || 0
      };
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, quotes });
  } catch (err) {
    console.error('Equity quote proxy error:', err.message);
    return res.status(502).json({ success: false, message: 'Unable to load equity quotes' });
  }
});

app.get('/api/equity/history', async (req, res) => {
  if (!ACCESS_TOKEN) {
    return res.status(503).json({ success: false, message: 'Live market data is not configured' });
  }

  const instrumentKey = String(req.query.instrument_key || '').trim();
  const range = String(req.query.range || '5y').toLowerCase();
  const years = range === '1y' ? 1 : range === '3y' ? 3 : range === '5y' ? 5 : null;

  if (!validInstrumentKey(instrumentKey) || !years) {
    return res.status(400).json({ success: false, message: 'Invalid instrument_key or range' });
  }

  try {
    const now = new Date();
    const toDate = now.toISOString().slice(0, 10);
    const from = new Date(now);
    from.setUTCFullYear(from.getUTCFullYear() - years);
    const fromDate = from.toISOString().slice(0, 10);

    // Monthly candles keep the 5-year chart small while preserving long-term trend.
    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/months/1/${toDate}/${fromDate}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`
      }
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: response.status === 401 ? 'Upstox access token expired or invalid' : 'Historical market data unavailable'
      });
    }

    const candles = Array.isArray(body?.data?.candles) ? body.data.candles : [];
    const history = candles.map(c => ({
      date: c[0],
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]) || 0
    })).filter(c => Number.isFinite(c.close)).reverse();

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, range, history });
  } catch (err) {
    console.error('Equity historical proxy error:', err.message);
    return res.status(502).json({ success: false, message: 'Historical market data unavailable' });
  }
});

app.get('/api/market-stream', (req, res) => {

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control':
      'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.flushHeaders();

  res.write(
    `data: ${JSON.stringify(latest)}\n\n`
  );

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

function broadcast() {

  const payload =
    `data: ${JSON.stringify(latest)}\n\n`;

  for (const res of clients) {

    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function extractLtpc(feed) {

  if (!feed || typeof feed !== 'object') {
    return null;
  }

  if (feed.ltpc) {
    return feed.ltpc;
  }

  if (feed.ff?.indexFF?.ltpc) {
    return feed.ff.indexFF.ltpc;
  }

  if (feed.fullFeed?.indexFF?.ltpc) {
    return feed.fullFeed.indexFF.ltpc;
  }

  if (feed.fullFeed?.marketFF?.ltpc) {
    return feed.fullFeed.marketFF.ltpc;
  }

  if (feed.indexFF?.ltpc) {
    return feed.indexFF.ltpc;
  }

  return null;
}

function applyFeed(message) {

  let data = message;

  try {

    if (Buffer.isBuffer(data)) {
      data = data.toString('utf8');
    }

    if (typeof data === 'string') {
      data = JSON.parse(data);
    }

  } catch (_) {
    return;
  }

  const feeds =
    data?.feeds ||
    data?.data?.feeds;

  if (
    !feeds ||
    typeof feeds !== 'object'
  ) {
    return;
  }

  for (
    const [key, feed]
    of Object.entries(feeds)
  ) {

    const name = INSTRUMENT_NAMES[key];

    if (!name) continue;

    const ltpc =
      extractLtpc(feed);

    if (
      !ltpc ||
      typeof ltpc.ltp !== 'number'
    ) {
      continue;
    }

    const previousClose =
      Number(ltpc.cp);

    const changePct =
      Number.isFinite(previousClose) &&
      previousClose !== 0
        ? (
            (ltpc.ltp - previousClose) /
            previousClose
          ) * 100
        : null;

    latest[name] = {
      ltp: ltpc.ltp,

      close:
        Number.isFinite(previousClose)
          ? previousClose
          : null,

      changePct,

      ltt:
        ltpc.ltt || null
    };

    latest.updatedAt =
      Date.now();

    latest.error = null;

    saveMarketSnapshot(
      name,
      latest[name]
    );
  }

  broadcast();
}

function startUpstox() {
  if (!ACCESS_TOKEN) {
    console.warn(
      'Live market feed disabled: set UPSTOX_ACCESS_TOKEN in Render Environment Variables.'
    );
    return;
  }

  let socket = null;
  let reconnectTimer = null;
  let feedResponseType = null;
  let starting = false;

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => {
        latest.connected = false;
        latest.error = err?.message || 'Unable to start market feed';
        broadcast();
        scheduleReconnect();
      });
    }, 5000);
  };

  const authorize = async () => {
    const response = await fetch(
      'https://api.upstox.com/v3/feed/market-data-feed/authorize',
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          Accept: 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Upstox authorize failed: ${response.status}`);
    }

    const body = await response.json();
    const uri = body?.data?.authorized_redirect_uri;

    if (!uri) {
      throw new Error('No authorized websocket URI returned by Upstox');
    }

    return uri;
  };

  const loadFeedType = async () => {
    if (feedResponseType) return feedResponseType;
    const root = await protobuf.load(
      require('path').join(__dirname, 'schema.proto')
    );
    feedResponseType = root.lookupType(
      'com.upstox.marketdatafeeder.rpc.proto.FeedResponse'
    );
    return feedResponseType;
  };

  const parseBinaryFeed = async (raw) => {
    try {
      const FeedResponse = await loadFeedType();
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const decoded = FeedResponse.decode(buffer);
      const data = FeedResponse.toObject(decoded, {
        longs: Number,
        enums: String,
        defaults: false
      });

      const feeds = data?.feeds || data?.data?.feeds;
      if (!feeds || typeof feeds !== 'object') return;

      for (const [key, feed] of Object.entries(feeds)) {
        const name = INSTRUMENT_NAMES[key];
        if (!name) continue;

        const ltpc = extractLtpc(feed);
        const ltp = Number(ltpc?.ltp);
        const previousClose = Number(ltpc?.cp);
        if (!Number.isFinite(ltp)) continue;

        const changePct = Number.isFinite(previousClose) && previousClose !== 0
          ? ((ltp - previousClose) / previousClose) * 100
          : null;

        latest[name] = {
          ltp,
          close: Number.isFinite(previousClose) ? previousClose : null,
          changePct,
          ltt: ltpc?.ltt || null
        };
        latest.updatedAt = Date.now();
        latest.error = null;
        saveMarketSnapshot(name, latest[name]);
      }

      broadcast();
    } catch (err) {
      console.error('Market feed decode failed:', err.message);
    }
  };

  const connect = async () => {
    if (starting) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    starting = true;
    try {
      const uri = await authorize();
      socket = new WebSocket(uri, { followRedirects: true });
      socket.binaryType = 'arraybuffer';

      socket.on('open', () => {
        starting = false;
        latest.connected = true;
        latest.error = null;
        broadcast();

        const message = {
          guid: crypto.randomUUID(),
          method: 'sub',
          data: {
            mode: 'ltpc',
            instrumentKeys: Object.values(INSTRUMENTS)
          }
        };

        try {
          socket.send(Buffer.from(JSON.stringify(message)));
        } catch (err) {
          latest.error = `Subscription error: ${err.message}`;
          broadcast();
        }
      });

      socket.on('message', (message) => {
        if (Buffer.isBuffer(message) || message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
          parseBinaryFeed(message);
          return;
        }
        try {
          const data = JSON.parse(message.toString());
          applyFeed(data);
        } catch (_) {}
      });

      socket.on('error', (err) => {
        latest.connected = false;
        latest.error = err?.message || 'Market feed connection error';
        broadcast();
      });

      socket.on('close', () => {
        starting = false;
        latest.connected = false;
        if (!latest.error) latest.error = 'Market feed disconnected';
        broadcast();
        scheduleReconnect();
      });
    } catch (err) {
      starting = false;
      latest.connected = false;
      latest.error = err?.message || 'Unable to start market feed';
      broadcast();
      console.error('Upstox market feed:', err.message);
      scheduleReconnect();
    }
  };

  connect();
}

/* =========================
AUTH HELPERS
========================= */

function normalizeEmail(email) {

  return String(email || '')
    .trim()
    .toLowerCase();
}

function normalizePhone(phone) {

  return String(phone || '')
    .replace(/\s+/g, '')
    .trim();
}

function generateClientId() {

  const random =
    Math.floor(
      100000 +
      Math.random() * 900000
    );

  return `AE${random}`;
}

function requireLogin(
  req,
  res,
  next
) {

  if (!req.session?.clientId) {

    return res.status(401).json({
      success: false,
      message: 'Login required'
    });
  }

  next();
}

/* =========================
CLIENT REGISTRATION
========================= */

app.post(
  '/api/auth/register',
  async (req, res) => {

    if (!pool || !databaseReady) {

      return res.status(503).json({
        success: false,
        message:
          'Authentication database is unavailable'
      });
    }

    try {

      const name =
        String(req.body.name || '')
          .trim();

      const phone =
        normalizePhone(
          req.body.phone || req.body.mobile
        );

      const email =
        normalizeEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password || ''
        );

      if (
        !name ||
        !phone ||
        !email ||
        !password
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Name, phone, email and password are required'
        });
      }

      if (name.length > 100) {

        return res.status(400).json({
          success: false,
          message: 'Name is too long'
        });
      }

      if (password.length < 8) {

        return res.status(400).json({
          success: false,
          message:
            'Password must contain at least 8 characters'
        });
      }

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
          .test(email)
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Invalid email address'
        });
      }

      const existing =
        await pool.query(
          `SELECT client_id
           FROM clients
           WHERE email = $1
           OR phone = $2
           LIMIT 1`,
          [email, phone]
        );

      if (
        existing.rows.length > 0
      ) {

        return res.status(409).json({
          success: false,
          message:
            'Email or phone number is already registered'
        });
      }

      let clientId;

      for (
        let i = 0;
        i < 10;
        i++
      ) {

        const candidate =
          generateClientId();

        const check =
          await pool.query(
            `SELECT id
             FROM clients
             WHERE client_id = $1`,
            [candidate]
          );

        if (
          check.rows.length === 0
        ) {

          clientId =
            candidate;

          break;
        }
      }

      if (!clientId) {

        return res.status(500).json({
          success: false,
          message:
            'Unable to create Client ID'
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      await pool.query(
        `INSERT INTO clients
         (
           client_id,
           name,
           phone,
           email,
           password_hash
         )
         VALUES
         ($1, $2, $3, $4, $5)`,
        [
          clientId,
          name,
          phone,
          email,
          passwordHash
        ]
      );

      return res.status(201).json({
        success: true,
        message:
          'Registration successful',
        clientId,
        client: {
          clientId,
          client_id: clientId,
          name,
          phone,
          email
        }
      });

    } catch (err) {

      console.error(
        'Registration error:',
        err.message
      );

      return res.status(500).json({
        success: false,
        message:
          'Registration failed'
      });
    }
  }
);


/* =========================
ACCOUNT RECOVERY
========================= */

app.post(
  '/api/auth/forgot-client',
  async (req, res) => {
    if (!pool || !databaseReady) {
      return res.status(503).json({
        success: false,
        message: 'Authentication database is unavailable'
      });
    }

    try {
      const rawContact = String(req.body.contact || '').trim();
      const email = normalizeEmail(rawContact);
      const phone = normalizePhone(rawContact).replace(/\D/g, '');

      if (!rawContact) {
        return res.status(400).json({
          success: false,
          message: 'Registered mobile number or email is required'
        });
      }

      const result = await pool.query(
        `SELECT client_id
         FROM clients
         WHERE LOWER(email) = $1
            OR REGEXP_REPLACE(phone, '\\D', '', 'g') = $2
         LIMIT 1`,
        [email, phone]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: 'No account found with that mobile number or email'
        });
      }

      return res.json({
        success: true,
        clientId: result.rows[0].client_id
      });
    } catch (err) {
      console.error('Forgot Client ID error:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Unable to recover Client ID'
      });
    }
  }
);

app.post(
  '/api/auth/forgot-password',
  async (req, res) => {
    if (!pool || !databaseReady) {
      return res.status(503).json({
        success: false,
        message: 'Authentication database is unavailable'
      });
    }

    try {
      const clientId = String(req.body.clientId || '').trim().toUpperCase();
      const rawContact = String(req.body.contact || '').trim();
      const email = normalizeEmail(rawContact);
      const phone = normalizePhone(rawContact).replace(/\D/g, '');
      const password = String(req.body.password || '');

      if (!clientId || !rawContact || !password) {
        return res.status(400).json({
          success: false,
          message: 'Client ID, registered mobile/email and new password are required'
        });
      }

      if (!/^AE\d{6}$/.test(clientId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid Client ID'
        });
      }

      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[@#₹]/.test(password)) {
        return res.status(400).json({
          success: false,
          message: 'Password must be minimum 8 characters and contain 1 uppercase, 1 number and 1 special character (@/#/₹).'
        });
      }

      const result = await pool.query(
        `SELECT client_id
         FROM clients
         WHERE client_id = $1
           AND (LOWER(email) = $2
                OR REGEXP_REPLACE(phone, '\\D', '', 'g') = $3)
         LIMIT 1`,
        [clientId, email, phone]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: 'Client ID and registered contact do not match'
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      await pool.query(
        `UPDATE clients
         SET password_hash = $1
         WHERE client_id = $2`,
        [passwordHash, clientId]
      );

      return res.json({
        success: true,
        message: 'Password reset successfully'
      });
    } catch (err) {
      console.error('Forgot password error:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Unable to reset password'
      });
    }
  }
);

/* =========================
CLIENT LOGIN
========================= */

app.post(
  '/api/auth/login',
  async (req, res) => {

    if (!pool || !databaseReady) {

      return res.status(503).json({
        success: false,
        message:
          'Authentication database is unavailable'
      });
    }

    try {

      const clientId =
        String(
          req.body.clientId || ''
        ).trim();

      const password =
        String(
          req.body.password || ''
        );

      if (
        !clientId ||
        !password
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Client ID and password are required'
        });
      }

      const result =
        await pool.query(
          `SELECT
             id,
             client_id,
             name,
             phone,
             email,
             password_hash,
             status
           FROM clients
           WHERE client_id = $1
           LIMIT 1`,
          [clientId]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid Client ID or password'
        });
      }

      const client =
        result.rows[0];

      if (
        client.status !== 'active'
      ) {

        return res.status(403).json({
          success: false,
          message:
            'Account is not active'
        });
      }

      const passwordCorrect =
        await bcrypt.compare(
          password,
          client.password_hash
        );

      if (!passwordCorrect) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid Client ID or password'
        });
      }

      req.session.clientId =
        client.client_id;

      req.session.userType =
        'client';

      const remember = req.body.remember === true;
      req.session.cookie.maxAge = remember ? 1000 * 60 * 60 * 24 * 30 : null;

      await new Promise((resolve, reject) => {
        req.session.save(err => err ? reject(err) : resolve());
      });

      return res.json({
        success: true,

        client: {
          clientId:
            client.client_id,

          name:
            client.name,

          email:
            client.email,
          phone:
            client.phone
        }
      });

    } catch (err) {

      console.error(
        'Login error:',
        err.message
      );

      return res.status(500).json({
        success: false,
        message:
          'Login failed'
      });
    }
  }
);

/* =========================
CURRENT USER
========================= */

app.get(
  '/api/auth/me',
  requireLogin,
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `SELECT
             client_id,
             name,
             email,
             phone,
             status,
             created_at
           FROM clients
           WHERE client_id = $1
           LIMIT 1`,
          [
            req.session.clientId
          ]
        );

      if (
        result.rows.length === 0
      ) {

        req.session.destroy(
          () => {}
        );

        return res.status(401).json({
          success: false,
          message:
            'Account not found'
        });
      }

      const client =
        result.rows[0];

      return res.json({
        success: true,

        client: {
          clientId:
            client.client_id,

          name:
            client.name,

          email:
            client.email,

          phone:
            client.phone,

          status:
            client.status,

          createdAt:
            client.created_at
        }
      });

    } catch (err) {

      console.error(
        'Session lookup error:',
        err.message
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load account'
      });
    }
  }
);

/* =========================
PROFILE UPDATE
========================= */

app.put(
  '/api/auth/profile',
  requireLogin,
  async (req, res) => {

    try {

      const name =
        String(
          req.body.name || ''
        ).trim();

      const phone =
        normalizePhone(
          req.body.phone || req.body.mobile
        );

      const email =
        normalizeEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password || ''
        );

      if (
        !name ||
        !/^\d{10}$/.test(phone) ||
        !/^\S+@\S+\.\S+$/.test(email)
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Valid name, mobile and email are required'
        });
      }

      if (
        password &&
        password.length < 8
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Password must contain at least 8 characters'
        });
      }

      const fields = [
        'name=$1',
        'phone=$2',
        'email=$3'
      ];

      const vals = [
        name,
        phone,
        email
      ];

      if (password) {

        fields.push(
          'password_hash=$4'
        );

        vals.push(
          await bcrypt.hash(
            password,
            12
          )
        );
      }

      vals.push(
        req.session.clientId
      );

      const result =
        await pool.query(
          `UPDATE clients
           SET ${fields.join(', ')}
           WHERE client_id=$${vals.length}
           RETURNING
             client_id,
             name,
             phone,
             email`,
          vals
        );

      if (
        !result.rows.length
      ) {

        return res.status(404).json({
          success: false,
          message:
            'Account not found'
        });
      }

      res.json({
        success: true,
        client:
          result.rows[0]
      });

    } catch (err) {

      console.error(
        'Profile update error:',
        err.message
      );

      res.status(500).json({
        success: false,
        message:
          'Profile update failed'
      });
    }
  }
);

/* =========================
PAYMENT CONFIRMATION
========================= */

app.post(
  '/api/payments/confirm',
  requireLogin,
  async (req, res) => {

    if (
      !pool ||
      !databaseReady
    ) {

      return res.status(503).json({
        success: false,
        message:
          'Database unavailable'
      });
    }

    try {

      const course =
        String(
          req.body.course || ''
        ).trim();

      const utr =
        String(
          req.body.utr || ''
        ).trim();

      const slipName =
        String(
          req.body.slipName || ''
        ).trim();

      const slipData =
        String(
          req.body.slipData || ''
        );

      if (
        !course ||
        !utr ||
        !slipName ||
        !slipData
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Payment details are required'
        });
      }

      const result =
        await pool.query(
          `INSERT INTO payment_confirmations
           (
             client_id,
             course,
             amount,
             utr,
             slip_name,
             slip_data
           )
           VALUES
           ($1, $2, 999, $3, $4, $5)
           RETURNING id, created_at`,
          [
            req.session.clientId,
            course,
            utr,
            slipName,
            slipData
          ]
        );

      res.status(201).json({
        success: true,
        paymentId:
          result.rows[0].id,

        createdAt:
          result.rows[0].created_at
      });

    } catch (err) {

      console.error(
        'Payment confirmation error:',
        err.message
      );

      res.status(500).json({
        success: false,
        message:
          'Payment confirmation failed'
      });
    }
  }
);

/* =========================
LOGOUT
========================= */

app.post(
  '/api/auth/logout',
  (req, res) => {

    req.session.destroy(
      (err) => {

        if (err) {

          return res.status(500).json({
            success: false,
            message:
              'Logout failed'
          });
        }

        res.clearCookie(
          'connect.sid'
        );

        return res.json({
          success: true,
          message:
            'Logged out successfully'
        });
      }
    );
  }
);

/* =========================
HEALTH CHECK
========================= */

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      success: true,

      server:
        'online',

      database:
        databaseReady
          ? 'connected'
          : 'not-connected',

      marketFeed:
        latest.connected
          ? 'connected'
          : 'disconnected',

      time:
        new Date().toISOString()
    });
  }
);

/* =========================
START SERVER
========================= */

app.listen(
  PORT,
  async () => {

    console.log(
      `AlphaEdge running on port ${PORT}`
    );

    await initDatabase();

    startUpstox();
  }
);
