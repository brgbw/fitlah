# FitLah Tech Stack

This document summarizes the main technologies used in FitLah and what each piece is responsible for.

## Application Overview

FitLah is a local-first Flask web app for IPPT training. It combines account-based activity tracking, webcam exercise logging, Strava run import, 2.4km/IPPT run analysis, group features, calendar records, and optional AI coaching.

## Backend

| Layer | Technology | Purpose |
| --- | --- | --- |
| Web framework | Flask 3 | Routes, request handling, sessions, templates, API endpoints |
| Language | Python 3.11+ | Backend application code and integrations |
| Database access | SQLAlchemy 2 | PostgreSQL/Neon connection management and SQL execution |
| Database driver | psycopg2-binary | PostgreSQL adapter for Python |
| Config loading | python-dotenv | Loads `.env` values during local startup |
| HTTP client | requests | Calls Strava and OpenRouter APIs |
| Secret encryption | cryptography / Fernet | Encrypts stored app secrets and OAuth tokens |
| TLS trust helper | truststore, certifi | Improves local SSL certificate handling for API calls |

Key backend folders:

```text
fitlah/
  core/                  Flask app setup, auth, config, constants, validation, web security
  data_access/           PostgreSQL engine, schema setup, encryption, repository helpers
  domain/                IPPT scoring, activity helpers, user profile, session files
  integrations/          Strava API client and OpenRouter AI coaching
  maintenance/           One-off database maintenance commands
  routes/                Flask route modules
```

## Frontend

| Layer | Technology | Purpose |
| --- | --- | --- |
| Templates | Jinja2 | Server-rendered pages from Flask |
| Styling | CSS in templates/static files | Dashboard, auth, calendar, webcam, Strava, and group UI |
| Browser logic | Vanilla JavaScript | Fetch APIs, page interactions, webcam exercise flows |
| Pose estimation | MediaPipe Pose | Client-side body landmark detection for push-up and sit-up counting |
| Maps | Leaflet | Strava route preview maps when GPS data is available |
| Charts | Browser canvas / page scripts | Dashboard and activity visualizations |

Key frontend folders:

```text
templates/              Jinja HTML pages and shared UI
static/js/              Page scripts and exercise counting logic
static/mediapipe/       Bundled MediaPipe runtime assets
static/icons/           App and integration icons
```

## Database

| Technology | Purpose |
| --- | --- |
| PostgreSQL / Neon | Primary local or hosted database |
| Auto-created tables | Created on first app startup through `fitlah/data_access/database.py` |

Main data areas:

- Users and login sessions
- Activity records for push-ups, sit-ups, runs, webcam sessions, manual entries, and Strava imports
- Personal bests and IPPT scoring data
- Fitness groups, group members, and invites
- Strava OAuth connections and IPPT 2.4km run results
- App settings such as Strava client credentials

## External Integrations

| Integration | Purpose | Required |
| --- | --- | --- |
| Strava API | OAuth login, recent run import, GPS stream fetching, 2.4km run analysis | Required for Strava sync |
| OpenRouter API | Optional AI coaching summaries and recommendations | Optional |
| Cloudflare Tunnel | Temporary public URL for hackathon demos and external user testing | Optional |
| Vercel | Hosted Flask deployment and custom domain management | Optional |
| Neon | Hosted PostgreSQL for Vercel deployments | Optional |

## Strava OAuth Flow

1. User clicks Connect with Strava.
2. Flask builds a Strava authorization URL.
3. `redirect_uri` points to `/strava-sync`.
4. Strava redirects back with an authorization code.
5. Browser posts the code to `/api/strava-callback`.
6. Backend exchanges the code for access and refresh tokens.
7. Tokens are stored encrypted in PostgreSQL.
8. Recent runs can be fetched, previewed, analyzed, and imported.

For Cloudflare demo testing, `.env` should use:

```env
FITLAH_PUBLIC_BASE_URL=auto
FITLAH_ALLOWED_ORIGINS=http://localhost:5000,http://127.0.0.1:5000,https://*.trycloudflare.com
```

## Security and Local Demo Controls

| Feature | Implementation |
| --- | --- |
| Session protection | Flask sessions with HTTP-only cookies |
| Origin checks | `fitlah/core/web_security.py` validates unsafe request origins |
| CORS support | Allowed origins from `.env`, including Cloudflare tunnel wildcard for demos |
| Rate limiting | In-memory per-user/IP route limits for sensitive endpoints |
| Token storage | Fernet encryption backed by `FIELD_ENCRYPTION_KEY` or `FITLAH_SECRET_KEY` |
| Upload limits | Flask `MAX_CONTENT_LENGTH` from `FITLAH_MAX_UPLOAD_BYTES` |

## Local Runtime

The app is launched directly with:

```powershell
python app.py
```

Default local URL:

```text
http://127.0.0.1:5000
```

Optional port override:

```powershell
$env:FLASK_RUN_PORT=5001
python app.py
```

## Cloud Runtime

For Vercel deployments, `app.py` exports the Flask `app` object that Vercel loads as the serverless entrypoint. Hosted deployments should use Neon PostgreSQL through `DATABASE_URL`, preferably with Neon's pooled connection string.

Core production environment values:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
FITLAH_PUBLIC_BASE_URL=https://your-domain.com
FITLAH_ALLOWED_ORIGINS=https://your-domain.com,https://your-project.vercel.app
FITLAH_PRODUCTION=true
FITLAH_COOKIE_SECURE=true
FITLAH_DB_DISABLE_POOL=true
```

## Dependency Files

| File | Purpose |
| --- | --- |
| `requirements.txt` | Python dependencies |
| `.env.example` | Safe local environment template |
| `instructions.txt` | Full laptop setup guide for teammates |
| `docs/POSTGRES_SETUP.md` | PostgreSQL installation and database walkthrough |
| `docs/VERCEL_NEON_SETUP.md` | Vercel custom domain and Neon deployment checklist |
