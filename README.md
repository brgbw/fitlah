# FitLah

Current project version: 0.1.8

FitLah is a cloud-deployed web app for Singapore IPPT training. It helps users track push-ups, sit-ups, and runs, import real running data from Strava, analyse 2.4km efforts, and review training progress from a shared Neon PostgreSQL database.

## What FitLah Does

- Account signup and login.
- Dashboard with personal bests and recent activity.
- Webcam push-up and sit-up session logging with MediaPipe pose detection.
- Calendar-based activity history.
- Strava OAuth connection and recent run import.
- 2.4km/IPPT-style run validation from Strava activity streams.
- Group and invite flows for shared training.
- Optional AI coaching through Gemini.

## Cloud Stack

- **Frontend/backend:** Flask, Jinja templates, vanilla JavaScript, CSS.
- **Deployment:** Vercel Python serverless runtime through `api/index.py`.
- **Database:** Neon PostgreSQL through `DATABASE_URL`.
- **Assets:** Static files served from the repository by Flask/Vercel.
- **Health checks:** `/healthz` for environment readiness and `/healthz/db` for database connectivity.

## Repository Layout

```text
api/index.py              Vercel Python entrypoint
fitlah/core/              Flask app setup, security, auth helpers
fitlah/data_access/       SQLAlchemy connection and repository helpers
fitlah/domain/            IPPT scoring and activity logic
fitlah/integrations/      Strava and AI clients
fitlah/routes/            Flask route modules
templates/                Jinja HTML templates
static/                   CSS, JavaScript, images, MediaPipe assets
docs/VERCEL_NEON_SETUP.md Deployment guide
```

## Deploy FitLah

Use the full deployment walkthrough in [`docs/VERCEL_NEON_SETUP.md`](docs/VERCEL_NEON_SETUP.md).

Short version:

1. Push this repository to GitHub.
2. Create a Neon project and copy the pooled PostgreSQL connection string.
3. Import the GitHub repository into Vercel.
4. Add the required Vercel Production environment variables.
5. Attach the `fitlah.vercel.app` project domain or your custom domain.
6. Redeploy the Production deployment.
7. Confirm `/healthz` and `/healthz/db` both return success.

## Use The Deployed App

Open the production URL:

```text
https://fitlah.vercel.app
```

Recommended first run:

1. Create a new account. Existing laptop/local accounts are not available unless you migrated data into Neon.
2. Open **Dashboard** to confirm the account session works.
3. Open **Exercise Recording Station**.
4. Choose **Push-Up** or **Sit-Up**.
5. Use **Start Camera** for a live browser camera session, or **Attach Video** to analyse an existing clip.
6. Save the session. FitLah stores rep counts, movement metrics, personal bests, and AI notes in Neon.
7. Open **Done** to review the session analysis.
8. Open **Calendar** or **Analytics** to see saved activity history.

Camera and video notes:

- Browser camera access requires HTTPS, which Vercel provides.
- The browser analyses the video locally with MediaPipe.
- Raw video files are not stored on Vercel.
- Neon stores the workout record, movement analysis, and AI recommendation.

## Required Environment Variables

Set these in **Vercel -> Project -> Settings -> Environment Variables** for **Production**:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
FITLAH_SECRET_KEY=replace-with-a-long-random-secret
FITLAH_PRODUCTION=true
FITLAH_COOKIE_SECURE=true
FITLAH_DB_DISABLE_POOL=true
FITLAH_PUBLIC_BASE_URL=https://fitlah.vercel.app
FITLAH_ALLOWED_ORIGINS=https://fitlah.vercel.app
FITLAH_ALLOW_STRAVA_SETTINGS_WRITE=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
```

`FIELD_ENCRYPTION_KEY` is optional. If omitted, FitLah derives encryption from `FITLAH_SECRET_KEY`.

## Strava Setup

Create a Strava API app at:

```text
https://www.strava.com/settings/api
```

Use your deployed domain:

```text
Website: https://fitlah.vercel.app
Authorization Callback Domain: fitlah.vercel.app
```

Strava wants only the domain in the callback field. Do not include `https://`, `/strava-sync`, or a trailing slash.

After saving, copy the Strava Client ID and Client Secret into FitLah:

```text
FitLah -> Settings -> Strava ID / Client secret
```

## Verify Deployment

After every production redeploy, open:

```text
https://fitlah.vercel.app/healthz
https://fitlah.vercel.app/healthz/db
https://fitlah.vercel.app/healthz/ai
```

Expected results:

```json
{"database":"configured","missing_recommended":[],"missing_required":[],"success":true}
```

```json
{"database":"ok","success":true}
```

For AI:

```json
{"api_key_present":true,"model":"gemini-2.5-flash","provider":"gemini","sdk_available":true,"success":true}
```

## Production Notes

- Vercel reads environment variables from the project dashboard.
- Neon data starts empty unless you intentionally migrate existing data.
- The app creates required database tables on first request.
- Vercel functions have an ephemeral filesystem, so uploaded webcam videos are not long-term durable storage.
- Webcam recordings and attached videos are analysed in the browser; FitLah saves session metrics and AI notes to Neon rather than storing video files on Vercel.
- Do not commit `.env`, secrets, API keys, virtual environments, or user uploads.

## Quick Troubleshooting

- **Logged in but buttons return to Login:** confirm `FITLAH_SECRET_KEY` is set in Vercel Production, redeploy, then clear browser cookies.
- **Database save fails:** check `/healthz/db` and verify `DATABASE_URL` uses the Neon pooled connection string.
- **AI does not respond:** check `/healthz/ai`, confirm `GEMINI_API_KEY` is set in Vercel Production, and redeploy.
- **Camera does not start:** use `https://fitlah.vercel.app`, allow browser camera permissions, and avoid protected preview deployment URLs.
- **Strava redirect fails:** confirm `FITLAH_PUBLIC_BASE_URL` matches the deployed domain and Strava callback domain is the domain only.
