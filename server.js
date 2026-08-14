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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const configured = process.env.FRONTEND_ORIGIN;
  const allowed = !origin || origin === 'null' ||
    (configured && origin === configured) ||
    /^https:\/\/[^/]+\.onrender\.com$/.test(origin) ||
    /^https:\/\/[^/]+\.github\.io$/.test(origin) ||
    /^http:\/\/localhost(?::\d+)?$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
        phone VARCHAR(20) UNIQUE,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS whatsapp_otps (
        id BIGSERIAL PRIMARY KEY,
        phone VARCHAR(30) NOT NULL,
        otp_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS whatsapp_otps_phone_idx
      ON whatsapp_otps(phone, created_at DESC);

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

    await pool.query(`ALTER TABLE clients ALTER COLUMN phone DROP NOT NULL`);
    await pool.query(`ALTER TABLE clients ALTER COLUMN password_hash DROP NOT NULL`);
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

// Frontend exposes a broader equity list than the original 12-instrument feed.
// Keep the frontend unchanged and resolve these NSE symbols to their current
// Upstox instrument keys at startup from Upstox's official instrument master.
const MARKET_SYMBOLS = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AUBANK', 'AXISBANK',
  'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BANKBARODA', 'BEL', 'BHARTIARTL',
  'BRITANNIA', 'CANBK', 'CIPLA', 'COALINDIA', 'DIVISLAB', 'DRREDDY',
  'EICHERMOT', 'ETERNAL', 'FEDERALBNK', 'GRASIM', 'HCLTECH', 'HDFCBANK',
  'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK',
  'IDFCFIRSTB', 'INDUSINDBK', 'INFY', 'IOC', 'ITC', 'JIOFIN', 'JSWSTEEL',
  'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'MOTHERSON', 'NESTLEIND', 'NTPC',
  'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN',
  'SUNPHARMA', 'TATACONSUM', 'TATAMOTORS', 'TMPV', 'TATASTEEL', 'TECHM', 'TITAN',
  'TRENT', 'ULTRACEMCO', 'WIPRO', 'HINDPETRO', 'BPCL', 'PIDILITIND',
  'SIEMENS', 'TATAELXSI', 'DABUR', 'INDIGO', 'AMBUJACEM'
];

const SYMBOL_TO_NAME = {
  ADANIENT: 'adani enterprises', ADANIPORTS: 'adani ports & sez', APOLLOHOSP: 'apollo hospitals',
  ASIANPAINT: 'asian paints', AUBANK: 'au small finance bank', AXISBANK: 'axis bank',
  'BAJAJ-AUTO': 'bajaj auto', BAJFINANCE: 'bajaj finance', BAJAJFINSV: 'bajaj finserv',
  BANKBARODA: 'bank of baroda', BEL: 'bharat electronics', BHARTIARTL: 'bharti airtel',
  BRITANNIA: 'britannia industries', CANBK: 'canara bank', CIPLA: 'cipla', COALINDIA: 'coal india',
  DIVISLAB: 'divi\'s laboratories', DRREDDY: 'dr. reddy\'s laboratories', EICHERMOT: 'eicher motors',
  ETERNAL: 'eternal', FEDERALBNK: 'federal bank', GRASIM: 'grasim industries', HCLTECH: 'hcl technologies',
  HDFCBANK: 'hdfc bank', HDFCLIFE: 'hdfc life insurance', HEROMOTOCO: 'hero motocorp',
  HINDALCO: 'hindalco industries', HINDUNILVR: 'hindustan unilever', ICICIBANK: 'icici bank',
  IDFCFIRSTB: 'idfc first bank', INDUSINDBK: 'indusind bank', INFY: 'infosys', IOC: 'indian oil corporation',
  ITC: 'itc', JIOFIN: 'jio financial services', JSWSTEEL: 'jsw steel', KOTAKBANK: 'kotak mahindra bank',
  LT: 'larsen & toubro', 'M&M': 'mahindra & mahindra', MARUTI: 'maruti suzuki india', MOTHERSON: 'samvardhana motherson',
  NESTLEIND: 'nestle india', NTPC: 'ntpc', ONGC: 'ongc', POWERGRID: 'power grid corp', RELIANCE: 'reliance industries',
  SBILIFE: 'sbi life insurance', SBIN: 'state bank of india', SHRIRAMFIN: 'shriram finance', SUNPHARMA: 'sun pharma',
  TATACONSUM: 'tata consumer products', TATAMOTORS: 'tata motors', TMPV: 'tata motors passenger vehicles', TATASTEEL: 'tata steel', TECHM: 'tech mahindra',
  TITAN: 'titan company', TRENT: 'trent', ULTRACEMCO: 'ultratech cement', WIPRO: 'wipro', HINDPETRO: 'hindustan petroleum',
  BPCL: 'bharat petroleum', PIDILITIND: 'pidilite industries', SIEMENS: 'siemens', TATAELXSI: 'tata elxsi',
  DABUR: 'dabur india', INDIGO: 'interglobe aviation', AMBUJACEM: 'ambuja cements'
};

// Build reverse lookups once so the API accepts either the NSE trading symbol
// (e.g. ADANIENT), the internal lowercase key (e.g. adanient), or the
// human-readable company name (e.g. "Adani Enterprises").
const SYMBOL_KEY_TO_SYMBOL = new Map(
  MARKET_SYMBOLS.map((symbol) => [symbol.toLowerCase(), symbol])
);

const COMPANY_NAME_TO_KEY = new Map(
  Object.entries(SYMBOL_TO_NAME).map(([symbol, name]) => [name.toLowerCase(), symbol.toLowerCase()])
);

function normalizeLookup(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

const NORMALIZED_SYMBOL_TO_KEY = new Map(
  MARKET_SYMBOLS.map((symbol) => [normalizeLookup(symbol), symbol.toLowerCase()])
);

function resolveMarketKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(INSTRUMENTS, lower)) {
    return lower;
  }

  const symbolKey = NORMALIZED_SYMBOL_TO_KEY.get(normalizeLookup(raw));
  if (symbolKey) return symbolKey;

  const nameKey = COMPANY_NAME_TO_KEY.get(lower);
  if (nameKey) return nameKey;

  const normalizedName = normalizeLookup(raw);
  for (const [name, key] of COMPANY_NAME_TO_KEY.entries()) {
    if (normalizeLookup(name) === normalizedName) return key;
  }

  return null;
}

for (const symbol of MARKET_SYMBOLS) {
  const key = symbol.toLowerCase();
  if (!INSTRUMENTS[key]) INSTRUMENTS[key] = null;
}

let INSTRUMENT_NAMES = Object.fromEntries(
  Object.entries(INSTRUMENTS)
    .filter(([, key]) => key)
    .map(([name, key]) => [key, name])
);

async function resolveMarketInstruments() {
  if (!ACCESS_TOKEN) return;

  try {
    const response = await fetch(
      'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz'
    );
    if (!response.ok) throw new Error(`Instrument master download failed: ${response.status}`);

    // Node's built-in fetch may transparently decompress gzip responses.
    // Therefore do NOT blindly gunzip the payload; inspect the gzip magic bytes first.
    const { gunzipSync } = require('zlib');
    const raw = Buffer.from(await response.arrayBuffer());
    const jsonText = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
      ? gunzipSync(raw).toString('utf8')
      : raw.toString('utf8');
    const instruments = JSON.parse(jsonText);
    const bySymbol = new Map();

    for (const item of instruments) {
      if (item?.segment !== 'NSE_EQ' || item?.instrument_type !== 'EQ') continue;

      const tradingSymbol = String(item.trading_symbol || '').toUpperCase();
      const shortName = String(item.short_name || '').toUpperCase();
      const instrumentName = String(item.name || '').toUpperCase();

      for (const candidate of [tradingSymbol, shortName, instrumentName]) {
        const normalized = normalizeLookup(candidate);
        if (normalized && !bySymbol.has(normalized)) {
          bySymbol.set(normalized, item.instrument_key);
        }
      }
    }

    for (const symbol of MARKET_SYMBOLS) {
      const key = symbol.toLowerCase();
      const candidates = [
        symbol,
        SYMBOL_TO_NAME[symbol] || '',
        symbol === 'M&M' ? 'MAHINDRA & MAHINDRA' : '',
        symbol === 'TMPV' ? 'TATA MOTORS PASSENGER VEHICLES' : '',
        symbol === 'INDIGO' ? 'INTERGLOBE AVIATION' : ''
      ];
      const instrumentKey = candidates
        .map(normalizeLookup)
        .map(v => bySymbol.get(v))
        .find(Boolean);
      if (instrumentKey) INSTRUMENTS[key] = instrumentKey;
    }

    INSTRUMENT_NAMES = Object.fromEntries(
      Object.entries(INSTRUMENTS)
        .filter(([, key]) => key)
        .map(([name, key]) => [key, name])
    );
    rebuildInstrumentAliases();

    console.log(`Resolved ${Object.keys(INSTRUMENT_NAMES).length} market instruments from Upstox master.`);
  } catch (err) {
    console.error('Upstox instrument master resolution failed:', err.message);
  }
}

const INSTRUMENT_ALIASES = new Map();

function rebuildInstrumentAliases() {
  INSTRUMENT_ALIASES.clear();
  for (const [name, key] of Object.entries(INSTRUMENTS)) {
    if (!key) continue;
    const names = INSTRUMENT_ALIASES.get(key) || [];
    names.push(name);
    INSTRUMENT_ALIASES.set(key, names);
  }
}

rebuildInstrumentAliases();


let latest = {
  ...Object.fromEntries(Object.keys(INSTRUMENTS).map(name => [name, null])),
  // Compatibility aliases for the frontend. Equity Hub commonly indexes
  // quotes by the NSE symbol (ADANIENT), while older pages used lowercase
  // internal keys. Keep both forms pointing to the same quote object.
  ...Object.fromEntries(MARKET_SYMBOLS.map(symbol => [symbol, null])),
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

let quoteRefreshPromise = null;
let lastQuoteRefreshAt = 0;

async function refreshEquityQuotes(force = false) {
  if (!ACCESS_TOKEN) return;
  const now = Date.now();
  if (!force && now - lastQuoteRefreshAt < 8000) return;
  if (quoteRefreshPromise) return quoteRefreshPromise;

  const keys = [...new Set(Object.entries(INSTRUMENTS)
    .filter(([name, key]) => name !== 'nifty' && name !== 'sensex' && name !== 'banknifty' && key)
    .map(([, key]) => key))];
  if (!keys.length) return;

  quoteRefreshPromise = (async () => {
    try {
      // Upstox Full Market Quotes supports up to 500 instruments per request.
      const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`;
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Quote refresh failed: ${response.status}`);

      for (const payload of Object.values(body?.data || {})) {
        const key = payload?.instrument_token;
        if (!key) continue;
        const ltp = Number(payload.last_price);
        const close = Number(payload?.ohlc?.close);
        if (!Number.isFinite(ltp)) continue;
        updateLatestForInstrument(key, {
          ltp,
          cp: Number.isFinite(close) ? close : null,
          ltt: Number(payload.last_trade_time) || null
        });
      }
      latest.updatedAt = Date.now();
      latest.error = null;
      broadcast();
      lastQuoteRefreshAt = Date.now();
    } catch (err) {
      latest.error = err?.message || 'Unable to refresh market quotes';
      console.error('Upstox quote refresh:', err.message);
    } finally {
      quoteRefreshPromise = null;
    }
  })();

  return quoteRefreshPromise;
}

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    service: 'AlphaEdge backend',
    databaseReady,
    authReady: Boolean(pool && databaseReady),
    marketFeedConfigured: Boolean(ACCESS_TOKEN)
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin.html'));
});

app.use(express.static(__dirname));

app.get('/api/market', async (req, res) => {
  await refreshEquityQuotes();
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

app.get('/api/market/equity-quotes', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!ACCESS_TOKEN) {
    return res.status(503).json({ success: false, message: 'Live market data is not configured' });
  }

  // Ensure the complete current Upstox instrument mapping is available before
  // resolving the requested symbols. This does not alter the UI or company list.
  const unresolved = MARKET_SYMBOLS.some(symbol => !INSTRUMENTS[symbol.toLowerCase()]);
  if (unresolved) await resolveMarketInstruments();

  const requested = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 500);

  if (!requested.length) {
    return res.status(400).json({ success: false, message: 'symbols is required' });
  }

  const resolved = requested
    .map(requestedSymbol => ({
      requestedSymbol,
      key: resolveMarketKey(requestedSymbol),
      instrumentKey: resolveMarketKey(requestedSymbol)
        ? INSTRUMENTS[resolveMarketKey(requestedSymbol)]
        : null
    }))
    .filter(x => x.instrumentKey);

  if (!resolved.length) {
    return res.json({ success: true, quotes: {} });
  }

  const quoteUrl =
    `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(resolved.map(x => x.instrumentKey).join(','))}`;

  try {
    const response = await fetch(quoteUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Equity quote request failed:', response.status, body?.errors || body?.message || '');
      return res.status(response.status).json({
        success: false,
        message: response.status === 401
          ? 'Upstox access token expired or invalid'
          : 'Equity market data unavailable'
      });
    }

    const byInstrument = body?.data && typeof body.data === 'object' ? body.data : {};
    const quotes = {};

    for (const item of resolved) {
      const raw = Object.values(byInstrument).find(q => q?.instrument_token === item.instrumentKey);
      if (!raw) continue;

      const price = Number(raw.last_price);
      const close = Number(raw.ohlc?.close);
      const netChange = Number(raw.net_change);
      const changePct = Number.isFinite(price) && Number.isFinite(close) && close !== 0
        ? ((price - close) / close) * 100
        : (Number.isFinite(netChange) && Number.isFinite(price - netChange) && (price - netChange) !== 0
          ? (netChange / (price - netChange)) * 100
          : null);

      quotes[item.requestedSymbol.toUpperCase()] = {
        price: Number.isFinite(price) ? price : null,
        close: Number.isFinite(close) ? close : null,
        changePct: Number.isFinite(changePct) ? changePct : null,
        netChange: Number.isFinite(netChange) ? netChange : null,
        provider: 'Upstox'
      };
    }

    return res.json({ success: true, quotes });
  } catch (err) {
    console.error('Equity quote error:', err.message);
    return res.status(502).json({ success: false, message: 'Equity market data unavailable' });
  }
});

app.get('/api/market/history-v3', async (req, res) => {
  const requestedSymbol = String(req.query.symbol || 'nifty').trim();
  const range = String(req.query.range || '5y').toLowerCase();
  const interval = String(req.query.interval || '').toLowerCase();
  const symbol = resolveMarketKey(requestedSymbol);
  let instrumentKey = symbol ? INSTRUMENTS[symbol] : null;

  if (symbol && !instrumentKey && ACCESS_TOKEN) {
    await resolveMarketInstruments();
    instrumentKey = INSTRUMENTS[symbol] || null;
  }

  if (!instrumentKey) {
    return res.status(400).json({ success:false, message:'Invalid chart symbol' });
  }
  if (!ACCESS_TOKEN) {
    return res.status(503).json({ success:false, message:'Live market data is not configured' });
  }

  // Range buttons control the visible period. Interval controls candle granularity.
  // Upstox V3 supports minutes (1-300), hours (1-5), days, weeks and months.
  // For long ranges we intentionally use daily/weekly/monthly candles so the
  // response stays practical; short ranges can use 1m/5m/15m/30m/1h candles.
  const now = new Date();
  const toDate = now.toISOString().slice(0,10);
  let unit, candleInterval, from;

  const daysBack = (n) => { const d=new Date(now); d.setUTCDate(d.getUTCDate()-n); return d; };
  const monthsBack = (n) => { const d=new Date(now); d.setUTCMonth(d.getUTCMonth()-n); return d; };
  const yearsBack = (n) => { const d=new Date(now); d.setUTCFullYear(d.getUTCFullYear()-n); return d; };

  if (range === '1d') {
    // Current trading day: intraday endpoint gives the freshest candles.
    unit = 'minutes';
    candleInterval = ['1','5','15','30'].includes(interval) ? interval : '1';
  } else if (range === '1w') {
    from = daysBack(7);
    if (['1','5','15','30'].includes(interval)) { unit='minutes'; candleInterval=interval; }
    else if (interval === '60') { unit='hours'; candleInterval='1'; }
    else { unit='days'; candleInterval='1'; }
  } else if (range === '1m') {
    from = monthsBack(1);
    if (['1','5','15'].includes(interval)) { unit='minutes'; candleInterval=interval; }
    else if (interval === '30') { unit='minutes'; candleInterval='30'; }
    else if (interval === '60') { unit='hours'; candleInterval='1'; }
    else { unit='days'; candleInterval='1'; }
  } else if (range === '3m') {
    from = monthsBack(3);
    if (interval === '30') { unit='minutes'; candleInterval='30'; }
    else if (interval === '60') { unit='hours'; candleInterval='1'; }
    else { unit='days'; candleInterval='1'; }
  } else if (range === '6m') {
    from = monthsBack(6); unit='days'; candleInterval='1';
  } else if (range === '1y') {
    from = yearsBack(1); unit='days'; candleInterval='1';
  } else if (range === '5y') {
    // Five years exceeds the practical daily-candle retrieval window for a single request.
    // Upstox V3 documents weekly/monthly candles for long ranges, so use weekly candles here.
    from = yearsBack(5); unit='weeks'; candleInterval='1';
  } else {
    return res.status(400).json({success:false,message:'Invalid chart range'});
  }

  try {
    let url;
    if (range === '1d') {
      url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${candleInterval}`;
    } else {
      const fromDate = from.toISOString().slice(0,10);
      url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${candleInterval}/${toDate}/${fromDate}`;
    }

    const response = await fetch(url, {
      headers: { Accept:'application/json', Authorization:`Bearer ${ACCESS_TOKEN}` }
    });
    const body = await response.json().catch(()=>({}));
    if (!response.ok) {
      console.error(`Historical data failed for ${requestedSymbol}:`, response.status, body?.errors || body?.message || '');
      return res.status(response.status).json({
        success:false,
        message: response.status===401 ? 'Upstox access token expired or invalid' : 'Historical market data unavailable'
      });
    }

    const candles = Array.isArray(body?.data?.candles) ? body.data.candles : [];
    const history = candles.map(c => ({
      date:c[0], open:Number(c[1]), high:Number(c[2]), low:Number(c[3]),
      close:Number(c[4]), volume:Number(c[5])
    })).filter(c=>Number.isFinite(c.close)).reverse();

    res.set('Cache-Control','no-store');
    return res.json({
      success:true,
      symbol:SYMBOL_KEY_TO_SYMBOL.get(symbol)||symbol,
      range,
      interval: interval || (range==='1d'?'1':'1D'),
      unit,
      history
    });
  } catch(err) {
    console.error('Historical market data error:',err.message);
    return res.status(502).json({success:false,message:'Historical market data unavailable'});
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

function updateLatestForInstrument(key, ltpc) {
  if (!ltpc || typeof ltpc.ltp !== 'number') return;

  const previousClose = Number(ltpc.cp);
  const changePct = Number.isFinite(previousClose) && previousClose !== 0
    ? ((ltpc.ltp - previousClose) / previousClose) * 100
    : null;

  const value = {
    ltp: ltpc.ltp,
    close: Number.isFinite(previousClose) ? previousClose : null,
    changePct,
    ltt: ltpc.ltt || null
  };

  const names = INSTRUMENT_ALIASES.get(key) || (INSTRUMENT_NAMES[key] ? [INSTRUMENT_NAMES[key]] : []);
  for (const name of names) {
    const quote = { ...value };
    latest[name] = quote;

    // Also publish by the actual NSE trading symbol so Equity Hub cards,
    // search results and detail pages can consume the same live quote.
    const symbol = SYMBOL_KEY_TO_SYMBOL.get(name);
    if (symbol) latest[symbol] = quote;

    saveMarketSnapshot(name, quote);
  }
  latest.updatedAt = Date.now();
  latest.error = null;
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
    const ltpc = extractLtpc(feed);
    updateLatestForInstrument(key, ltpc);
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
        updateLatestForInstrument(key, extractLtpc(feed));
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
            instrumentKeys: Object.values(INSTRUMENTS).filter(Boolean)
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

function authTokenSecret(){
  return process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET || 'CHANGE_THIS_SESSION_SECRET';
}

function createAuthToken(clientId, provider='social'){
  const payload = {
    clientId: String(clientId),
    provider: String(provider),
    exp: Math.floor(Date.now()/1000) + 60 * 60 * 24 * 30
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', authTokenSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAuthToken(token){
  try{
    const [body, sig] = String(token||'').split('.');
    if(!body || !sig) return null;
    const expected = crypto.createHmac('sha256', authTokenSecret()).update(body).digest('base64url');
    const a=Buffer.from(sig);
    const b=Buffer.from(expected);
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
    const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!payload?.clientId || Number(payload.exp||0) < Math.floor(Date.now()/1000)) return null;
    return payload;
  }catch(_){ return null; }
}

function getAuthClientId(req){
  if(req.session?.clientId) return req.session.clientId;
  const header=String(req.headers.authorization||'');
  if(/^Bearer\s+/i.test(header)){
    const payload=verifyAuthToken(header.replace(/^Bearer\s+/i,''));
    if(payload?.clientId) return payload.clientId;
  }
  return null;
}

function requireLogin(
  req,
  res,
  next
) {
  const clientId=getAuthClientId(req);
  if(!clientId) {
    return res.status(401).json({
      success: false,
      message: 'Login required'
    });
  }
  req.authClientId=clientId;
  next();
}

/* =========================
WHATSAPP OTP LOGIN
========================= */

function normalizedWhatsappPhone(value){
  let p=String(value||'').replace(/[^\d+]/g,'');
  if(p.startsWith('00')) p='+'+p.slice(2);
  if(!p.startsWith('+')) p='+'+p;
  return p;
}

async function createOrGetPhoneClient(phone, name='AlphaEdge User'){
  if(!pool || !databaseReady) throw new Error('Authentication database is unavailable');
  const result=await pool.query(`SELECT id,client_id,name,phone,email,status FROM clients WHERE phone=$1 LIMIT 1`,[phone]);
  let client=result.rows[0];
  if(client && client.status!=='active') throw new Error('Account is not active.');
  if(!client){
    let clientId=null;
    for(let i=0;i<20;i++){
      const candidate=generateClientId();
      const check=await pool.query(`SELECT 1 FROM clients WHERE client_id=$1`,[candidate]);
      if(!check.rows.length){clientId=candidate;break;}
    }
    if(!clientId) throw new Error('Unable to create Client ID.');
    // WhatsApp/Truecaller may not provide an email. Keep a private internal
    // placeholder so the existing email-unique schema remains compatible.
    const internalEmail=`phone_${phone.replace(/\D/g,'')}@alphaedge.local`;
    const created=await pool.query(
      `INSERT INTO clients(client_id,name,phone,email,password_hash,status)\n       VALUES($1,$2,$3,$4,NULL,'active')\n       RETURNING id,client_id,name,phone,email,status`,
      [clientId,String(name||'AlphaEdge User').slice(0,100),phone,internalEmail]
    );
    client=created.rows[0];
  }
  return client;
}

app.post('/api/auth/whatsapp/request', async (req,res)=>{
  try{
    if(!pool || !databaseReady) return res.status(503).json({success:false,message:'Authentication database is unavailable.'});
    const token=process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID;
    const templateName=process.env.WHATSAPP_OTP_TEMPLATE_NAME;
    const language=process.env.WHATSAPP_OTP_LANGUAGE||'en_US';
    if(!token || !phoneNumberId || !templateName){
      return res.status(503).json({success:false,message:'WhatsApp OTP is not configured on the server.'});
    }
    const phone=normalizedWhatsappPhone(req.body.phone);
    if(!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({success:false,message:'Enter a valid WhatsApp number with country code.'});
    const otp=String(crypto.randomInt(100000,1000000));
    const otpHash=crypto.createHash('sha256').update(otp).digest('hex');
    await pool.query(`DELETE FROM whatsapp_otps WHERE phone=$1 OR expires_at<NOW()`,[phone]);
    await pool.query(`INSERT INTO whatsapp_otps(phone,otp_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '5 minutes')`,[phone,otpHash]);

    const version=process.env.WHATSAPP_GRAPH_VERSION||'v24.0';
    const url=`https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
    const body={
      messaging_product:'whatsapp',to:phone.replace(/^\+/,''),type:'template',
      template:{name:templateName,language:{code:language},components:[{type:'body',parameters:[{type:'text',text:otp}]}]}
    };
    const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok){
      await pool.query(`DELETE FROM whatsapp_otps WHERE phone=$1`,[phone]);
      console.error('WhatsApp API error:',data);
      return res.status(502).json({success:false,message:'WhatsApp could not send the OTP. Check your Meta WhatsApp configuration.'});
    }
    req.session.whatsappPendingPhone=phone;
    return res.json({success:true,message:'OTP sent on WhatsApp.'});
  }catch(err){
    console.error('WhatsApp OTP request error:',err.message);
    return res.status(500).json({success:false,message:'Unable to start WhatsApp login.'});
  }
});

app.post('/api/auth/whatsapp/verify', async (req,res)=>{
  try{
    if(!pool || !databaseReady) return res.status(503).json({success:false,message:'Authentication database is unavailable.'});
    const phone=normalizedWhatsappPhone(req.body.phone);
    const otp=String(req.body.otp||'').trim();
    if(phone!==req.session.whatsappPendingPhone) return res.status(400).json({success:false,message:'WhatsApp verification session expired. Please request a new OTP.'});
    if(!/^\d{6}$/.test(otp)) return res.status(400).json({success:false,message:'Enter the 6-digit OTP.'});
    const result=await pool.query(`SELECT id,otp_hash,expires_at,attempts FROM whatsapp_otps WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`,[phone]);
    const row=result.rows[0];
    if(!row || new Date(row.expires_at).getTime()<Date.now()) return res.status(400).json({success:false,message:'OTP expired. Please request a new one.'});
    if(row.attempts>=5) return res.status(429).json({success:false,message:'Too many attempts. Please request a new OTP.'});
    const hash=crypto.createHash('sha256').update(otp).digest('hex');
    if(hash!==row.otp_hash){
      await pool.query(`UPDATE whatsapp_otps SET attempts=attempts+1 WHERE id=$1`,[row.id]);
      return res.status(400).json({success:false,message:'Invalid OTP.'});
    }
    await pool.query(`DELETE FROM whatsapp_otps WHERE id=$1`,[row.id]);
    const client=await createOrGetPhoneClient(phone);
    req.session.clientId=client.client_id;
    req.session.userType='client';
    req.session.socialProvider='whatsapp';
    delete req.session.whatsappPendingPhone;
    await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
    return res.json({success:true,clientId:client.client_id,name:client.name});
  }catch(err){
    console.error('WhatsApp OTP verify error:',err.message);
    return res.status(500).json({success:false,message:'WhatsApp verification failed.'});
  }
});

/* =========================
TRUECALLER LOGIN
========================= */

app.get('/api/auth/truecaller',(req,res)=>{
  const clientId=process.env.TRUECALLER_CLIENT_ID;
  const authorizeUrl=process.env.TRUECALLER_AUTHORIZE_URL;
  if(!clientId || !authorizeUrl){
    return res.status(503).send('Truecaller login is not configured on the server.');
  }
  const state=crypto.randomBytes(24).toString('hex');
  req.session.oauthState=state;
  req.session.oauthProvider='truecaller';
  req.session.oauthNextSymbol=String(req.query.nextSymbol||'').trim().slice(0,80);
  const redirectUri=process.env.TRUECALLER_REDIRECT_URI || `${(process.env.BACKEND_PUBLIC_URL||'https://alphaedge-backend-loxi.onrender.com').replace(/\/+$/,'')}/api/auth/truecaller/callback`;
  const params=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:process.env.TRUECALLER_SCOPE||'profile',state});
  return res.redirect(authorizeUrl+(authorizeUrl.includes('?')?'&':'?')+params.toString());
});

app.get('/api/auth/truecaller/callback',async(req,res)=>{
  const frontend=oauthFrontendUrl();
  try{
    if(!req.query.code || !req.query.state || req.query.state!==req.session.oauthState) throw new Error('Truecaller verification failed. Please try again.');
    if(req.session.oauthProvider!=='truecaller') throw new Error('Truecaller login session mismatch.');
    const clientId=process.env.TRUECALLER_CLIENT_ID;
    const clientSecret=process.env.TRUECALLER_CLIENT_SECRET;
    const tokenUrl=process.env.TRUECALLER_TOKEN_URL;
    const profileUrl=process.env.TRUECALLER_PROFILE_URL;
    if(!clientId || !clientSecret || !tokenUrl || !profileUrl) throw new Error('Truecaller login is not fully configured on the server.');
    const redirectUri=process.env.TRUECALLER_REDIRECT_URI || `${(process.env.BACKEND_PUBLIC_URL||'https://alphaedge-backend-loxi.onrender.com').replace(/\/+$/,'')}/api/auth/truecaller/callback`;
    const tokenRes=await fetch(tokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code:String(req.query.code),redirect_uri:redirectUri,grant_type:'authorization_code'})});
    const token=await tokenRes.json().catch(()=>({}));
    if(!tokenRes.ok || !token.access_token) throw new Error('Truecaller authorization failed.');
    const profileRes=await fetch(profileUrl,{headers:{Authorization:`Bearer ${token.access_token}`}});
    const profile=await profileRes.json().catch(()=>({}));
    if(!profileRes.ok) throw new Error('Unable to read Truecaller profile.');
    const phone=normalizedWhatsappPhone(profile.phoneNumber||profile.phone||profile.number);
    if(!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Truecaller did not return a verified phone number.');
    const client=await createOrGetPhoneClient(phone,profile.name||profile.firstName||'AlphaEdge User');
    req.session.clientId=client.client_id; req.session.userType='client'; req.session.socialProvider='truecaller';
    const nextSymbol=String(req.session.oauthNextSymbol||'').trim();
    delete req.session.oauthState; delete req.session.oauthProvider; delete req.session.oauthNextSymbol;
    await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
    const target=new URL(frontend); target.searchParams.set('social','success'); target.searchParams.set('clientId',client.client_id); target.searchParams.set('authToken',createAuthToken(client.client_id,'truecaller')); if(nextSymbol) target.searchParams.set('nextSymbol',nextSymbol);
    return res.redirect(target.toString());
  }catch(err){
    console.error('truecaller OAuth error:',err.message);
    const target=new URL(frontend); target.searchParams.set('social','error'); target.searchParams.set('message',err.message||'Truecaller login failed'); return res.redirect(target.toString());
  }
});

/* =========================
SOCIAL LOGIN — GOOGLE / FACEBOOK
========================= */

function oauthFrontendUrl(){
  return process.env.OAUTH_FRONTEND_URL ||
    process.env.FRONTEND_ORIGIN ||
    'https://alphaedge-c3yf.onrender.com';
}

function oauthRedirectUri(provider){
  const base=process.env.BACKEND_PUBLIC_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : 'https://alphaedge-backend-loxi.onrender.com');
  const fallback=base.replace(/\/+$/,'');
  return process.env[provider==='google'?'GOOGLE_REDIRECT_URI':'FACEBOOK_REDIRECT_URI'] ||
    `${fallback}/api/auth/${provider}/callback`;
}

async function finishSocialLogin(req, provider, profile){
  if(!pool || !databaseReady) throw new Error('Authentication database is unavailable');
  const email=normalizeEmail(profile.email);
  if(!email) throw new Error('The social account did not provide an email address.');

  let result=await pool.query(
    `SELECT id,client_id,name,phone,email,status FROM clients WHERE LOWER(email)=$1 LIMIT 1`,
    [email]
  );

  let client=result.rows[0];
  if(client && client.status!=='active') throw new Error('Account is not active.');

  if(!client){
    let clientId=null;
    for(let i=0;i<20;i++){
      const candidate=generateClientId();
      const check=await pool.query(`SELECT 1 FROM clients WHERE client_id=$1`,[candidate]);
      if(!check.rows.length){clientId=candidate;break;}
    }
    if(!clientId) throw new Error('Unable to create Client ID.');

    const created=await pool.query(
      `INSERT INTO clients(client_id,name,phone,email,password_hash,status)
       VALUES($1,$2,NULL,$3,NULL,'active')
       RETURNING id,client_id,name,phone,email,status`,
      [clientId,String(profile.name||'AlphaEdge User').slice(0,100),email]
    );
    client=created.rows[0];
  }

  req.session.clientId=client.client_id;
  req.session.userType='client';
  req.session.socialProvider=provider;
  await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
  return client;
}

app.get('/api/auth/:provider', (req,res)=>{
  const provider=String(req.params.provider||'').toLowerCase();
  if(!['google','facebook'].includes(provider)) return res.status(404).send('Unsupported social login.');
  const clientId=provider==='google'?process.env.GOOGLE_CLIENT_ID:process.env.FACEBOOK_APP_ID;
  const clientSecret=provider==='google'?process.env.GOOGLE_CLIENT_SECRET:process.env.FACEBOOK_APP_SECRET;
  if(!clientId || !clientSecret){
    return res.status(503).send(`${provider[0].toUpperCase()+provider.slice(1)} login is not configured on the server.`);
  }
  const state=crypto.randomBytes(24).toString('hex');
  req.session.oauthState=state;
  req.session.oauthProvider=provider;
  req.session.oauthNextSymbol=String(req.query.nextSymbol||'').trim().slice(0,80);
  const redirectUri=oauthRedirectUri(provider);

  if(provider==='google'){
    const params=new URLSearchParams({
      client_id:clientId,
      redirect_uri:redirectUri,
      response_type:'code',
      scope:'openid email profile',
      state,
      access_type:'online',
      prompt:'select_account'
    });
    return res.redirect('https://accounts.google.com/o/oauth2/v2/auth?'+params.toString());
  }

  const version=process.env.FACEBOOK_GRAPH_VERSION||'v24.0';
  const params=new URLSearchParams({
    client_id:clientId,
    redirect_uri:redirectUri,
    response_type:'code',
    scope:'email,public_profile',
    state
  });
  return res.redirect(`https://www.facebook.com/${version}/dialog/oauth?`+params.toString());
});

app.get('/api/auth/:provider/callback', async (req,res)=>{
  const provider=String(req.params.provider||'').toLowerCase();
  const frontend=oauthFrontendUrl();
  try{
    if(!['google','facebook'].includes(provider)) throw new Error('Unsupported social login.');
    if(!req.query.code || !req.query.state || req.query.state!==req.session.oauthState){
      throw new Error('Social login verification failed. Please try again.');
    }
    if(provider!==req.session.oauthProvider) throw new Error('Social login provider mismatch.');

    const clientId=provider==='google'?process.env.GOOGLE_CLIENT_ID:process.env.FACEBOOK_APP_ID;
    const clientSecret=provider==='google'?process.env.GOOGLE_CLIENT_SECRET:process.env.FACEBOOK_APP_SECRET;
    const redirectUri=oauthRedirectUri(provider);
    let profile={};

    if(provider==='google'){
      const tokenRes=await fetch('https://oauth2.googleapis.com/token',{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({
          client_id:clientId,client_secret:clientSecret,code:String(req.query.code),
          redirect_uri:redirectUri,grant_type:'authorization_code'
        })
      });
      const token=await tokenRes.json();
      if(!tokenRes.ok || !token.access_token) throw new Error('Google authorization failed.');
      const userRes=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{
        headers:{Authorization:`Bearer ${token.access_token}`}
      });
      const user=await userRes.json();
      if(!userRes.ok) throw new Error('Unable to read Google account.');
      profile={email:user.email,name:user.name};
    }else{
      const version=process.env.FACEBOOK_GRAPH_VERSION||'v24.0';
      const tokenUrl=`https://graph.facebook.com/${version}/oauth/access_token?`+
        new URLSearchParams({
          client_id:clientId,client_secret:clientSecret,code:String(req.query.code),redirect_uri:redirectUri
        }).toString();
      const tokenRes=await fetch(tokenUrl);
      const token=await tokenRes.json();
      if(!tokenRes.ok || !token.access_token) throw new Error('Facebook authorization failed.');
      const userUrl=`https://graph.facebook.com/${version}/me?fields=id,name,email&access_token=${encodeURIComponent(token.access_token)}`;
      const userRes=await fetch(userUrl);
      const user=await userRes.json();
      if(!userRes.ok) throw new Error('Unable to read Facebook account.');
      profile={email:user.email,name:user.name};
    }

    const client=await finishSocialLogin(req,provider,profile);
    const nextSymbol=String(req.session.oauthNextSymbol||'').trim();
    delete req.session.oauthState;
    delete req.session.oauthProvider;
    delete req.session.oauthNextSymbol;
    const target=new URL(frontend);
    target.searchParams.set('social','success');
    target.searchParams.set('clientId',client.client_id);
    target.searchParams.set('authToken',createAuthToken(client.client_id,provider));
    if(nextSymbol) target.searchParams.set('nextSymbol',nextSymbol);
    return res.redirect(target.toString());
  }catch(err){
    console.error(`${provider} OAuth error:`,err.message);
    const target=new URL(frontend);
    target.searchParams.set('social','error');
    target.searchParams.set('message',err.message||'Social login failed');
    return res.redirect(target.toString());
  }
});

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
            req.authClientId || req.session.clientId
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
ADMIN AUTH / CLIENTS
========================= */

function requireAdmin(req, res, next) {
  if (!req.session?.adminUser) {
    return res.status(401).json({
      success: false,
      message: 'Admin login required'
    });
  }
  next();
}

app.post('/api/admin/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const expectedUser = String(process.env.ADMIN_USERNAME || '').trim();
  const expectedPass = String(process.env.ADMIN_PASSWORD || '');

  if (!expectedUser || !expectedPass) {
    return res.status(503).json({
      success: false,
      message: 'Admin credentials are not configured'
    });
  }

  if (username !== expectedUser || password !== expectedPass) {
    return res.status(401).json({
      success: false,
      message: 'Invalid admin username or password'
    });
  }

  req.session.adminUser = username;
  req.session.userType = 'admin';

  return res.json({
    success: true,
    admin: { username }
  });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({
    success: true,
    admin: { username: req.session.adminUser }
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.adminUser = null;
  if (req.session.userType === 'admin') req.session.userType = null;
  req.session.save(() => {
    res.json({ success: true });
  });
});

app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  if (!pool || !databaseReady) {
    return res.status(503).json({
      success: false,
      message: 'Database unavailable'
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        client_id,
        name,
        phone,
        email,
        status,
        created_at
      FROM clients
      ORDER BY created_at DESC
    `);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      clients: result.rows
    });
  } catch (err) {
    console.error('Admin clients error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Unable to load clients'
    });
  }
});



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
API ERROR SAFETY
Always return JSON for unknown /api routes and API errors.
This prevents the frontend from trying to parse an HTML <!DOCTYPE...> page as JSON.
========================= */
app.use('/api', (req, res) => {
  if (res.headersSent) return;
  return res.status(404).json({
    success: false,
    message: `API route not found: ${req.method} ${req.path}`
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err?.stack || err?.message || err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
  return res.status(500).send('Internal server error');
});

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

    await resolveMarketInstruments();
    await refreshEquityQuotes(true);
    startUpstox();
  }
);
