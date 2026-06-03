# Vercel and Neon Setup

Use this guide when deploying FitLah from GitHub to Vercel with Neon as the hosted PostgreSQL database.

## 1. Create the Neon database

1. Create a Neon project at https://neon.tech.
2. Open the Neon project dashboard and click **Connect**.
3. Select the FitLah database and role.
4. Enable connection pooling and copy the pooled connection string.

The URL should look like:

```text
postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
```

Neon requires SSL. FitLah also adds `sslmode=require` automatically when the host ends in `.neon.tech` and the URL does not already include it.

## 2. Create the Vercel project

1. Push this repository to GitHub.
2. In Vercel, create a new project and import the repository.
3. Keep the framework preset as **Other** if Vercel does not detect Flask automatically.
4. Leave the build command empty unless Vercel asks for one.

FitLah exposes a Flask `app` instance from `app.py`, which is one of Vercel's supported Flask entrypoints. The included `vercel.json` rewrites all app routes to that Flask entrypoint.

## 3. Add Vercel environment variables

Add these in **Project Settings -> Environment Variables** for Production, Preview, and Development as needed:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require&channel_binding=require
FITLAH_SECRET_KEY=replace-with-a-long-random-secret
FIELD_ENCRYPTION_KEY=optional-fernet-key
FITLAH_PRODUCTION=true
FITLAH_COOKIE_SECURE=true
FITLAH_DB_DISABLE_POOL=true
FITLAH_PUBLIC_BASE_URL=https://your-domain.com
FITLAH_ALLOWED_ORIGINS=https://your-domain.com,https://your-project.vercel.app
FITLAH_ALLOW_STRAVA_SETTINGS_WRITE=false
GEMINI_API_KEY=optional-gemini-key
GEMINI_MODEL=gemini-3.1-flash-lite
```

Notes:

- Use the Neon pooled connection string for Vercel because serverless functions can create many short-lived connections.
- Set `FITLAH_PUBLIC_BASE_URL` to the final production domain once the domain is attached.
- Keep `FITLAH_ALLOW_STRAVA_SETTINGS_WRITE=false` in production if Strava credentials should not be editable from the settings page.

## 4. Attach the Vercel domain

1. Open the Vercel project.
2. Go to **Settings -> Domains**.
3. Add your custom domain, for example `fitlah.example.com`.
4. Follow Vercel's DNS instructions at your domain registrar.
5. After Vercel verifies the domain, update:

```env
FITLAH_PUBLIC_BASE_URL=https://fitlah.example.com
FITLAH_ALLOWED_ORIGINS=https://fitlah.example.com,https://your-project.vercel.app
```

Redeploy after changing environment variables.

## 5. Configure Strava for the production domain

In Strava API settings, use only the domain name:

```text
Authorization Callback Domain: fitlah.example.com
```

Do not include `https://`, `/strava-sync`, or a trailing slash. FitLah will generate the full redirect URL from `FITLAH_PUBLIC_BASE_URL`.

## Vercel runtime notes

- Vercel functions have an ephemeral filesystem. Uploaded webcam videos may not persist between function invocations.
- The first request creates or updates the PostgreSQL tables in Neon.
- For long-term production use of uploaded videos, move `userdata` storage to object storage such as Vercel Blob or S3.
