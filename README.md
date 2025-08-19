# Easee EV Charger Web Interface

A lightweight web dashboard to monitor and control an Easee EV charger. It uses a small Node/Express backend that proxies to the Easee Cloud API and serves a modern frontend (Tailwind + Chart.js).

References: See the official docs for capabilities and limitations: [Easee Developer Platform](https://developer.easee.com/docs/integrations).

## Features

- Login with Easee credentials (site owner account)
- Select charger (auto-fetch list) or enter Charger ID manually
- Live charging data with a real‑time chart
- Set charging current, pause/resume charging
- Current session info (time, energy, cost)
- 24h energy view (sessions and total kWh) with per‑session bar chart
- Live updates via SSE with fallback to polling
- Automatic token refresh using `refreshToken`
- UI preferences: light/dark theme, units, currency, live transport
- Basic multi‑charger overview panel

## Project layout

```text
./
├── server/                # Node/Express backend + static frontend
│   ├── index.js
│   ├── package.json
│   └── public/            # Frontend (HTML/CSS/JS)
│       ├── index.html
│       ├── styles.css
│       └── main.js
└── README.md
```

## Prerequisites

- Node.js 18+

### Setup

```bash
cd server
npm install
```

Optional `.env` in `server/`:

```env
PORT=3000
SESSION_SECRET=change_me
EASEE_API_BASE=https://api.easee.com
```

### Run locally

```bash
cd server
npm start
```

Open `http://localhost:3000/`.

### Docker

Build and run with Docker or Compose:

```bash
cd server
docker build -t easee-dashboard .
# Run with environment variables
docker run -e PORT=3000 -e SESSION_SECRET=change_me -e EASEE_API_BASE=https://api.easee.com -p 3000:3000 easee-dashboard

# Or with compose
docker compose up --build
```

### Using the app

1. Log in with your Easee username (email/phone) and password.
2. Pick your charger from the dropdown (or paste the Charger ID like `EH123456`).
3. The dashboard updates every ~5s. Use the slider and buttons to set current or pause/resume.

Notes:

- Sessions are cookie-based (httpOnly). For any exposed deployment, serve over HTTPS.
- If no chargers appear in the dropdown, enter the Charger ID manually.

### Backend endpoints

- `POST /api/login` — `{ username, password }`
- `POST /api/logout`
- `GET /api/chargers`
- `GET /api/state?chargerId=...`
- `GET /api/session?chargerId=...`
- `GET /api/sessions-24h?chargerId=...`
- `POST /api/set-current` — `{ chargerId, current }`
- `POST /api/pause` — `{ chargerId }`
- `POST /api/resume` — `{ chargerId }`

### Security & privacy

- Credentials are submitted to your local server, which then talks to the Easee Cloud.
- Cookies are `httpOnly` and `sameSite=lax`. For production behind HTTPS consider `sameSite=None` and `secure=true`.
- Avoid logging credentials or tokens.

### Suggestions for further improvements

- Implemented:
  - Token lifecycle: automatic refresh using `refreshToken` to avoid frequent logins.
  - Live updates: Server‑Sent Events (SSE) with fallback to polling.
  - Analytics: 24h energy chart with per‑session breakdown (bar chart).
  - UI polish: theming (light/dark), units/currency preferences, and a basic multi‑charger overview.
  - Error handling: friendlier messages and known Easee error mapping.
  - Packaging: Dockerfile and `docker-compose.yml` for one‑command runs.
  - Tests: mock the Easee API and add integration tests.

#### “Remember me” / storing login

Prefer storing tokens (access/refresh) instead of raw passwords.

- Local, single‑user: use OS keychain via `keytar` to store username/password; login once on startup and keep tokens fresh.
- Multi‑user/shared: store only refresh tokens server‑side (encrypted), rotate regularly; never store raw passwords.
- If persisting secrets, encrypt with a KMS (Vault, AWS KMS) and never expose to the client.

I can add a “Remember me” option that saves and refreshes tokens securely; let me know your preference.

### Tests

Run unit/integration tests (mocked Easee API):

```bash
cd server
npm install
npm test
```

### Troubleshooting

- Login loop: ensure cookies are enabled; hard refresh or try a private window.
- No chargers listed: enter Charger ID manually; backend can be extended to list via sites.
- Rate limits: increase poll interval.

### License

MIT (check Easee’s terms for API usage).