# FitLah Tech Stack

This document summarizes the production cloud architecture for FitLah.

## Application Overview

FitLah is a Flask web app deployed on Vercel with Neon PostgreSQL. It combines account-based activity tracking, webcam exercise logging, Strava run import, 2.4km/IPPT run analysis, group features, calendar records, and optional AI coaching.

## Backend

| Layer | Technology | Purpose |
| --- | --- | --- |
| Web framework | Flask 3 | Routes, request handling, sessions, templates, API endpoints |
| Runtime | Vercel Python serverless runtime | Hosts the Flask app through `api/index.py` |
| Language | Python 3.12 | Backend application code and integrations |
| Database access | SQLAlchemy 2 | Neon/PostgreSQL connection management and SQL execution |
| Database driver | psycopg2-binary | PostgreSQL adapter for Python |
| Config loading | Environment variables / python-dotenv | Vercel uses dashboard env vars; dotenv remains available for non-production tooling |
| HTTP client | requests | Calls Strava APIs |
| AI client | google-genai | Optional Gemini coaching responses |
| Secret encryption | cryptography / Fernet | Encrypts stored app secrets and OAuth tokens |
| TLS trust helper | truststore, certifi | Improves SSL certificate handling for external API calls |

Key backend folders:

```text
api/                    Vercel Python entrypoint
fitlah/
  core/                 Flask app setup, auth, config, validation, web security
  data_access/          Neon/PostgreSQL engine, schema setup, repository helpers
  domain/               IPPT scoring, activity helpers, user profile, session helpers
  integrations/         Strava API client and Gemini AI coaching
  maintenance/          One-off database maintenance commands
  routes/               Flask route modules
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
| Neon PostgreSQL | Hosted production database |
| SQLAlchemy schema bootstrap | Creates required tables on first request |

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
| Vercel | Hosts the Flask app and manages domains | Required |
| Neon | Hosted PostgreSQL database | Required |
| Strava API | OAuth login, recent run import, GPS stream fetching, 2.4km run analysis | Required for Strava sync |
| Gemini API | Optional AI coaching summaries and recommendations | Optional |

## Strava OAuth Flow

1. User clicks Connect with Strava.
2. Flask builds a Strava authorization URL from `FITLAH_PUBLIC_BASE_URL`.
3. `redirect_uri` points to `/strava-sync`.
4. Strava redirects back with an authorization code.
5. Browser posts the code to `/api/strava-callback`.
6. Backend exchanges the code for access and refresh tokens.
7. Tokens are stored encrypted in Neon.
8. Recent runs can be fetched, previewed, analyzed, and imported.

## Security Controls

| Feature | Implementation |
| --- | --- |
| Session protection | Flask sessions with HTTP-only cookies |
| Secure cookies | `FITLAH_COOKIE_SECURE=true` in production |
| Origin checks | `fitlah/core/web_security.py` validates unsafe request origins against `FITLAH_ALLOWED_ORIGINS` |
| Rate limiting | In-memory per-user/IP route limits for sensitive endpoints |
| Token storage | Fernet encryption backed by `FIELD_ENCRYPTION_KEY` or `FITLAH_SECRET_KEY` |
| Upload limits | Flask `MAX_CONTENT_LENGTH` from `FITLAH_MAX_UPLOAD_BYTES` |

## Vercel Runtime

Vercel loads:

```text
api/index.py
```

`api/index.py` imports the Flask app object:

```python
from fitlah.core.application import app
```

The root `app.py` file re-exports the same object for compatibility.

Core production environment values:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
FITLAH_PUBLIC_BASE_URL=https://fitlah.vercel.app
FITLAH_ALLOWED_ORIGINS=https://fitlah.vercel.app
FITLAH_PRODUCTION=true
FITLAH_COOKIE_SECURE=true
FITLAH_DB_DISABLE_POOL=true
```

## Health Checks

```text
/healthz
/healthz/db
```

`/healthz` confirms required environment variables exist.

`/healthz/db` confirms the Vercel function can connect to Neon.

## Dependency Files

| File | Purpose |
| --- | --- |
| `requirements.txt` | Python dependencies |
| `.env.example` | Safe cloud environment variable template |
| `instructions.txt` | Cloud implementation handoff guide |
| `docs/VERCEL_NEON_SETUP.md` | Vercel domain and Neon setup checklist |
