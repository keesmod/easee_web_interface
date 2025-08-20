require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const EASEE_API_BASE = process.env.EASEE_API_BASE || 'https://api.easee.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me_dev_secret';

app.use(cors({ origin: false }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory cache to reduce upstream API traffic and avoid rate limits
// Keyed by a string; each entry stores { value, expiresAt }
const apiCache = new Map();
const ENABLE_CACHE = (process.env.ENABLE_CACHE ?? 'true') !== 'false' && process.env.NODE_ENV !== 'test';
function cacheGet(key) {
  if (!ENABLE_CACHE) return undefined;
  const entry = apiCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt > Date.now()) return entry.value;
  apiCache.delete(key);
  return undefined;
}
function cacheSet(key, value, ttlMs) {
  if (!ENABLE_CACHE) return;
  apiCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function mapEaseeError(err) {
  const status = err.response?.status || 500;
  const code = err.response?.data?.error || err.response?.data?.code || undefined;
  const messageRaw = err.response?.data?.message || err.response?.data || err.message;
  const messageText = typeof messageRaw === 'string' ? messageRaw : JSON.stringify(messageRaw);
  if (status === 401) return { status, error: 'Authentication failed. Please login again.' };
  if (status === 403) return { status, error: 'Access denied for this account/charger.' };
  if (status === 404) return { status, error: 'Resource not found on Easee.' };
  if (status === 409) return { status, error: 'Operation conflicted with charger state. Try again.' };
  if (status === 422) return { status, error: 'Invalid parameters for Easee API.' };
  if (status === 429) return { status, error: 'Rate limit reached. Please slow down.' };
  if (status >= 500) return { status, error: 'Easee service temporarily unavailable.' };
  return { status, error: code ? `${code}: ${messageText}` : messageText };
}

function easeeClient(req) {
  return axios.create({
    baseURL: EASEE_API_BASE,
    headers: {
      Authorization: `Bearer ${req.session.accessToken}`
    },
    timeout: 15000
  });
}

async function refreshAccessToken(req) {
  const refreshToken = req.session?.refreshToken;
  if (!refreshToken) return false;
  try {
    const response = await axios.post(`${EASEE_API_BASE}/api/accounts/refresh_token`, {
      refreshToken
    }, { headers: { 'Content-Type': 'application/json' } });
    const { accessToken, refreshToken: newRefreshToken, expiresIn } = response.data || {};
    if (!accessToken) return false;
    req.session.accessToken = accessToken;
    if (newRefreshToken) req.session.refreshToken = newRefreshToken;
    req.session.tokenExpiresAt = expiresIn ? Date.now() + (expiresIn * 1000) : null;
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    return true;
  } catch (_e) {
    return false;
  }
}

async function ensureTokenFresh(req) {
  const tokenExpiresAt = req.session?.tokenExpiresAt;
  if (!tokenExpiresAt) return; // unknown; skip proactive refresh
  const now = Date.now();
  // Refresh if expiring within next 30 seconds
  if (tokenExpiresAt - now < 30_000) {
    await refreshAccessToken(req);
  }
}

async function withAutoRefresh(req, handler) {
  await ensureTokenFresh(req);
  try {
    const client = easeeClient(req);
    return await handler(client);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      const refreshed = await refreshAccessToken(req);
      if (refreshed) {
        const clientRetry = easeeClient(req);
        return await handler(clientRetry);
      }
    }
    throw err;
  }
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const response = await axios.post(`${EASEE_API_BASE}/api/accounts/login`, {
      userName: username,
      password
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    const { accessToken, refreshToken, expiresIn } = response.data || {};
    if (!accessToken) {
      return res.status(502).json({ error: 'No access token returned from Easee' });
    }

    req.session.regenerate((regenErr) => {
      if (regenErr) {
        return res.status(500).json({ error: 'Failed to start session' });
      }
      req.session.accessToken = accessToken;
      req.session.refreshToken = refreshToken || null;
      req.session.tokenExpiresAt = expiresIn ? Date.now() + (expiresIn * 1000) : null;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Failed to persist session' });
        res.json({ ok: true });
      });
    });
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error || 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const chargerId = req.query.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const cacheKey = `state:${chargerId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await withAutoRefresh(req, (client) => client.get(`/api/chargers/${encodeURIComponent(chargerId)}/state`).then(r => r.data));
    cacheSet(cacheKey, data, 3000); // 3s cache
    res.json(data);
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

app.get('/api/chargers', requireAuth, async (req, res) => {
  try {
    const cacheKey = 'chargers:list';
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await withAutoRefresh(req, (client) => client.get('/api/chargers').then(r => r.data));
    cacheSet(cacheKey, data, 30_000); // 30s cache
    res.json(data);
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

app.get('/api/session', requireAuth, async (req, res) => {
  try {
    const chargerId = req.query.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const cacheKey = `session:${chargerId}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return res.json(cached);
    const data = await withAutoRefresh(req, (client) => client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions/ongoing`).then(r => r.data));
    cacheSet(cacheKey, data ?? null, 3000); // 3s cache
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 500;
    if (status === 404) return res.json(null);
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

app.get('/api/sessions-24h', requireAuth, async (req, res) => {
  try {
    const chargerId = req.query.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const toIso = to.toISOString();
    const fromIso = from.toISOString();
    const cacheKey = `sessions24h:${chargerId}:${fromIso}:${toIso}`;
    const cached = cacheGet(cacheKey);
    const sessions = cached ?? await withAutoRefresh(req, (client) =>
      client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions`, { params: { from: fromIso, to: toIso } })
        .then(r => Array.isArray(r.data) ? r.data : [])
        .catch(err => (err.response?.status === 404 ? [] : Promise.reject(err)))
    );
    if (!cached) cacheSet(cacheKey, sessions, 60_000); // 60s cache
    let totalKwh = 0;
    for (const s of sessions) {
      const kwh = s.kwh ?? s.energy ?? s.totalEnergy ?? s.total_kwh ?? 0;
      if (typeof kwh === 'number') totalKwh += kwh;
    }
    res.json({ from: fromIso, to: toIso, sessionsCount: sessions.length, totalKwh, sessions });
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

// Past sessions over an arbitrary time window
app.get('/api/sessions-range', requireAuth, async (req, res) => {
  try {
    const chargerId = req.query.chargerId;
    const fromIso = req.query.from;
    const toIso = req.query.to;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    if (!fromIso || !toIso) return res.status(400).json({ error: 'from and to are required ISO timestamps' });
    const cacheKey = `sessionsRange:${chargerId}:${fromIso}:${toIso}`;
    const cached = cacheGet(cacheKey);
    const sessions = cached ?? await withAutoRefresh(req, (client) =>
      client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions`, { params: { from: fromIso, to: toIso } })
        .then(r => Array.isArray(r.data) ? r.data : [])
        .catch(err => (err.response?.status === 404 ? [] : Promise.reject(err)))
    );
    if (!cached) cacheSet(cacheKey, sessions, 60_000); // 60s cache
    let totalKwh = 0;
    for (const s of sessions) {
      const kwh = s.kwh ?? s.energy ?? s.totalEnergy ?? s.total_kwh ?? 0;
      if (typeof kwh === 'number') totalKwh += kwh;
    }
    res.json({ from: fromIso, to: toIso, sessionsCount: sessions.length, totalKwh, sessions });
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

app.post('/api/set-current', requireAuth, async (req, res) => {
  const chargerId = req.body?.chargerId;
  const current = req.body?.current;
  if (!chargerId || typeof current !== 'number') {
    return res.status(400).json({ error: 'chargerId and numeric current are required' });
  }
  try {
    const viaCommands = await withAutoRefresh(req, (client) =>
      client.post(`/api/chargers/${encodeURIComponent(chargerId)}/commands/set_charger_current`, { current })
    );
    return res.json({ ok: true, via: 'commands', response: viaCommands.data });
  } catch (err) {
    try {
      const viaSettings = await withAutoRefresh(req, (client) =>
        client.post(`/api/chargers/${encodeURIComponent(chargerId)}/settings`, { dynamicChargerCurrent: current })
      );
      return res.json({ ok: true, via: 'settings', response: viaSettings.data });
    } catch (err2) {
      const mapped = mapEaseeError(err2.response ? err2 : err);
      return res.status(mapped.status).json({ error: mapped.error });
    }
  }
});

app.post('/api/pause', requireAuth, async (req, res) => {
  try {
    const chargerId = req.body?.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const data = await withAutoRefresh(req, (client) => client.post(`/api/chargers/${encodeURIComponent(chargerId)}/commands/pause_charging`).then(r => r.data));
    res.json({ ok: true, response: data });
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

app.post('/api/resume', requireAuth, async (req, res) => {
  try {
    const chargerId = req.body?.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const data = await withAutoRefresh(req, (client) => client.post(`/api/chargers/${encodeURIComponent(chargerId)}/commands/resume_charging`).then(r => r.data));
    res.json({ ok: true, response: data });
  } catch (err) {
    const mapped = mapEaseeError(err);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

app.get('/api/healthy', (_req, res) => res.json({ ok: true }));

// Server-Sent Events for live updates
app.get('/api/stream', requireAuth, async (req, res) => {
  const chargerId = req.query.chargerId;
  if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let isClosed = false;
  req.on('close', () => { isClosed = true; clearInterval(timer); });

  // Throttle 24h history to once per minute to stay well below rate limits
  let lastHistory = null;
  let lastHistoryTs = 0;
  const HISTORY_TTL = 60_000; // 60s

  function send(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Immediately send a ping so client knows we are connected
  send('ping', { t: Date.now() });

  async function loadAllOnce() {
    try {
      const [state, session] = await Promise.all([
        withAutoRefresh(req, (client) => client.get(`/api/chargers/${encodeURIComponent(chargerId)}/state`).then(r => r.data)),
        withAutoRefresh(req, (client) => client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions/ongoing`).then(r => r.data).catch(e => (e.response?.status === 404 ? null : Promise.reject(e))))
      ]);

      let history = lastHistory;
      if (!history || (Date.now() - lastHistoryTs) > HISTORY_TTL) {
        const to = new Date();
        const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
        const toIso = to.toISOString();
        const fromIso = from.toISOString();
        const sessions = await withAutoRefresh(req, (client) =>
          client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions`, { params: { from: fromIso, to: toIso } })
            .then(r => Array.isArray(r.data) ? r.data : [])
            .catch(err => (err.response?.status === 404 ? [] : Promise.reject(err)))
        );
        let totalKwh = 0;
        for (const s of sessions) {
          const kwh = s.kwh ?? s.energy ?? s.totalEnergy ?? s.total_kwh ?? 0;
          if (typeof kwh === 'number') totalKwh += kwh;
        }
        history = { from: fromIso, to: toIso, sessionsCount: sessions.length, totalKwh, sessions };
        lastHistory = history;
        lastHistoryTs = Date.now();
      }
      send('state', state);
      send('session', session);
      send('history', history);
    } catch (err) {
      const mapped = mapEaseeError(err);
      send('error', { error: mapped.error, status: mapped.status });
    }
  }

  await loadAllOnce();
  // Slightly slower tick to reduce total request rate
  const timer = setInterval(() => { if (!isClosed) loadAllOnce(); }, 7000);
});

const serverInstance = app.listen(process.env.NODE_ENV === 'test' ? 0 : PORT, () => {
  if (process.env.NODE_ENV !== 'test') {
    /* eslint-disable no-console */
    console.log(`Server listening on http://localhost:${PORT}`);
  }
});

module.exports = { app, serverInstance };


