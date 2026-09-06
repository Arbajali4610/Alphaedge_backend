const express = require('express');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
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
        phone VARCHAR(20) UNIQUE,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
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

    // Allow OAuth-created accounts to complete their profile later.
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

let marketWs = null;
let marketReconnectTimer = null;
let marketConnectInProgress = false;
let marketProtoPromise = null;

async function getMarketFeedType() {
  if (!marketProtoPromise) {
    marketProtoPromise = protobuf.load(
      require('path').join(__dirname, 'schema.proto')
    ).then((root) =>
      root.lookupType(
        'com.upstox.marketdatafeeder.rpc.proto.FeedResponse'
      )
    );
  }

  return marketProtoPromise;
}

async function authorizeMarketFeed() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!token || token === 'PASTE_ACCESS_TOKEN_HERE') {
    throw new Error('UPSTOX_ACCESS_TOKEN is not configured');
  }

  const response = await fetch(
    'https://api.upstox.com/v3/feed/market-data-feed/authorize',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Upstox authorize failed: ${response.status}`
    );
  }

  const data = await response.json();
  const uri = data?.data?.authorized_redirect_uri;

  if (!uri) {
    throw new Error(
      'No authorized websocket URI returned by Upstox'
    );
  }

  return uri;
}

function scheduleMarketReconnect() {
  if (marketReconnectTimer) return;

  marketReconnectTimer = setTimeout(() => {
    marketReconnectTimer = null;
    startUpstox().catch(() => {
      scheduleMarketReconnect();
    });
  }, 5000);
}

async function handleMarketMessage(data) {
  try {
    const FeedResponse = await getMarketFeedType();

    const message =
      FeedResponse.decode(
        new Uint8Array(
          Buffer.isBuffer(data)
            ? data
            : Buffer.from(data)
        )
      );

    const json =
      FeedResponse.toObject(
        message,
        {
          longs: Number,
          enums: String,
          defaults: false
        }
      );

    const feeds = json?.feeds;

    if (!feeds || typeof feeds !== 'object') {
      return;
    }

    for (const [key, feed] of Object.entries(feeds)) {
      const name = INSTRUMENT_NAMES[key];
      if (!name) continue;

      const ltpc =
        feed?.ltpc ||
        feed?.ff?.indexFF?.ltpc ||
        feed?.fullFeed?.indexFF?.ltpc ||
        feed?.fullFeed?.marketFF?.ltpc ||
        feed?.indexFF?.ltpc;

      if (!ltpc) continue;

      const ltp = Number(ltpc.ltp);
      const previousClose = Number(ltpc.cp);

      if (!Number.isFinite(ltp)) continue;

      const changePct =
        Number.isFinite(previousClose) &&
        previousClose !== 0
          ? ((ltp - previousClose) / previousClose) * 100
          : null;

      latest[name] = {
        ltp,
        close: Number.isFinite(previousClose)
          ? previousClose
          : null,
        changePct,
        ltt: Number(ltpc.ltt) || null
      };

      latest.updatedAt = Date.now();
      latest.error = null;

      saveMarketSnapshot(name, latest[name]);
    }

    broadcast();
  } catch (err) {
    console.error(
      'Market feed message error:',
      err.message
    );
  }
}

async function startUpstox() {
  if (!ACCESS_TOKEN) {
    console.warn(
      'Live market feed disabled: set UPSTOX_ACCESS_TOKEN in Render Environment Variables.'
    );
    return;
  }

  if (
    marketWs &&
    (
      marketWs.readyState === WebSocket.OPEN ||
      marketWs.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  if (marketConnectInProgress) return;
  marketConnectInProgress = true;

  try {
    const uri = await authorizeMarketFeed();

    marketWs = new WebSocket(uri, {
      followRedirects: true
    });

    marketWs.binaryType = 'arraybuffer';

    marketWs.on('open', () => {
      marketConnectInProgress = false;

      latest.connected = true;
      latest.error = null;
      broadcast();

      try {
        marketWs.send(
          Buffer.from(
            JSON.stringify({
              guid: require('crypto').randomUUID(),
              method: 'sub',
              data: {
                mode: 'ltpc',
                instrumentKeys: Object.values(INSTRUMENTS)
              }
            })
          )
        );
      } catch (err) {
        latest.error =
          `Subscription error: ${err.message}`;
        broadcast();
      }
    });

    marketWs.on('message', handleMarketMessage);

    marketWs.on('error', (err) => {
      marketConnectInProgress = false;
      latest.connected = false;
      latest.error =
        err?.message ||
        'Market feed connection error';
      broadcast();
    });

    marketWs.on('close', () => {
      marketConnectInProgress = false;
      marketWs = null;

      latest.connected = false;
      latest.error = 'Market feed disconnected';
      broadcast();

      scheduleMarketReconnect();
    });
  } catch (err) {
    marketConnectInProgress = false;

    latest.connected = false;
    latest.error =
      err?.message ||
      'Unable to start market feed';

    broadcast();

    console.error(
      'Market feed startup error:',
      err.message
    );

    scheduleMarketReconnect();
  }
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

      if (
        !name ||
        !phone ||
        !email
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Name, phone and email are required'
        });
      }

      if (name.length > 100) {

        return res.status(400).json({
          success: false,
          message: 'Name is too long'
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

      await pool.query(
        `INSERT INTO clients
         (
           client_id,
           name,
           phone,
           email
         )
         VALUES
         ($1, $2, $3, $4)`,
        [
          clientId,
          name,
          phone,
          email
        ]
      );

      return res.status(201).json({
        success: true,
        message:
          'Registration successful',
        clientId,
        client: {
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
      req.session.save(() => {});

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
          req.body.phone
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
