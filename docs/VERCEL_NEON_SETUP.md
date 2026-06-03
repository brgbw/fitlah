# Vercel and Neon Setup

This is the production deployment guide for FitLah. The app is intended to run on Vercel with Neon PostgreSQL.

## 1. Create Neon

1. Create a Neon project at https://neon.tech.
2. Open **Connect** in the Neon project dashboard.
3. Select the app database and role.
4. Enable connection pooling.
5. Copy the pooled connection string.

Use a URL shaped like this:

```text
postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
```

FitLah also adds `sslmode=require` automatically when the host ends in `.neon.tech` and the URL does not already include it.

## 2. Create Vercel Project

1. Push this repository to GitHub.
2. Import the repository into Vercel.
3. Use **Framework Preset: Other**.
4. Leave Build Command, Output Directory, and Start Command blank/default.

Vercel loads the app through:

```text
api/index.py
```

`app.py` only re-exports the Flask app object for compatibility.

## 3. Add Production Environment Variables

Add these in **Project Settings -> Environment Variables** for **Production**:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
FITLAH_SECRET_KEY=replace-with-a-long-random-secret
FIELD_ENCRYPTION_KEY=
FITLAH_PRODUCTION=true
FITLAH_COOKIE_SECURE=true
FITLAH_DB_DISABLE_POOL=true
FITLAH_PUBLIC_BASE_URL=https://fitlah.vercel.app
FITLAH_ALLOWED_ORIGINS=https://fitlah.vercel.app
FITLAH_ALLOW_STRAVA_SETTINGS_WRITE=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
```

Redeploy Production after saving environment variables.

## 4. Configure Domain

Open **Project Settings -> Domains** in Vercel.

Confirm the production domain:

```text
fitlah.vercel.app
```

For a custom domain, add the domain in Vercel and update:

```env
FITLAH_PUBLIC_BASE_URL=https://your-domain.com
FITLAH_ALLOWED_ORIGINS=https://your-domain.com
```

Redeploy after updating domain-related variables.

## 5. Configure Strava

In Strava API settings, use:

```text
Website: https://fitlah.vercel.app
Authorization Callback Domain: fitlah.vercel.app
```

Do not include `https://`, `/strava-sync`, or a trailing slash in the callback domain.

## 6. Verify

Open:

```text
https://fitlah.vercel.app/healthz
https://fitlah.vercel.app/healthz/db
```

Expected:

```json
{"database":"configured","missing_recommended":[],"missing_required":[],"success":true}
```

```json
{"database":"ok","success":true}
```

Then create a new account in the deployed app and confirm Neon has a row in the `users` table.

## Runtime Notes

- Vercel does not read local `.env` files.
- The database starts empty unless you migrate data intentionally.
- FitLah creates required tables on first request.
- Webcam recordings and attached videos are analysed in the browser. FitLah saves metrics to Neon and does not store video files on Vercel.
