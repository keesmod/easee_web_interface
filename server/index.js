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

function requireAuth(req, res, next) {
  if (!req.session || !req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
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
    const status = err.response?.status || 500;
    const message = err.response?.data || err.message || 'Login failed';
    res.status(status).json({ error: message });
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
    const client = easeeClient(req);
    const response = await client.get(`/api/chargers/${encodeURIComponent(chargerId)}/state`);
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get('/api/chargers', requireAuth, async (req, res) => {
  try {
    const client = easeeClient(req);
    const response = await client.get('/api/chargers');
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get('/api/session', requireAuth, async (req, res) => {
  try {
    const chargerId = req.query.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const client = easeeClient(req);
    const response = await client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions/ongoing`);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    // 404 likely means no ongoing session
    if (status === 404) return res.json(null);
    res.status(status).json({ error: err.response?.data || err.message });
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

    const client = easeeClient(req);
    const response = await client.get(`/api/chargers/${encodeURIComponent(chargerId)}/sessions`, {
      params: { from: fromIso, to: toIso }
    });

    const sessions = Array.isArray(response.data) ? response.data : [];
    let totalKwh = 0;
    for (const s of sessions) {
      const kwh = s.kwh ?? s.energy ?? s.totalEnergy ?? s.total_kwh ?? 0;
      if (typeof kwh === 'number') totalKwh += kwh;
    }
    res.json({ from: fromIso, to: toIso, sessionsCount: sessions.length, totalKwh, sessions });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.post('/api/set-current', requireAuth, async (req, res) => {
  const chargerId = req.body?.chargerId;
  const current = req.body?.current;
  if (!chargerId || typeof current !== 'number') {
    return res.status(400).json({ error: 'chargerId and numeric current are required' });
  }
  const client = easeeClient(req);

  // Try commands endpoint first
  try {
    const response = await client.post(`/api/chargers/${encodeURIComponent(chargerId)}/commands/set_charger_current`, {
      current: current
    });
    return res.json({ ok: true, via: 'commands', response: response.data });
  } catch (err) {
    // Fall back to settings endpoint if commands endpoint not available
    try {
      const response = await client.post(`/api/chargers/${encodeURIComponent(chargerId)}/settings`, {
        dynamicChargerCurrent: current
      });
      return res.json({ ok: true, via: 'settings', response: response.data });
    } catch (err2) {
      const status = err2.response?.status || err.response?.status || 500;
      return res.status(status).json({ error: err2.response?.data || err.response?.data || err2.message || err.message });
    }
  }
});

app.post('/api/pause', requireAuth, async (req, res) => {
  try {
    const chargerId = req.body?.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const client = easeeClient(req);
    const response = await client.post(`/api/chargers/${encodeURIComponent(chargerId)}/commands/pause_charging`);
    res.json({ ok: true, response: response.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.post('/api/resume', requireAuth, async (req, res) => {
  try {
    const chargerId = req.body?.chargerId;
    if (!chargerId) return res.status(400).json({ error: 'chargerId is required' });
    const client = easeeClient(req);
    const response = await client.post(`/api/chargers/${encodeURIComponent(chargerId)}/commands/resume_charging`);
    res.json({ ok: true, response: response.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get('/api/healthy', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Server listening on http://localhost:${PORT}`);
});


