# FitLah

Current project version: 0.1.4

FitLah is a web app for Singapore IPPT training. It helps users track push-ups, sit-ups, and runs, import real running data from Strava, analyse 2.4km efforts, and get training recommendations from their saved activity history.

## Project Overview

FitLah was built for a hackathon as a practical fitness companion for NSmen and anyone preparing for IPPT-style training. Instead of keeping exercise logs, Strava runs, webcam rep counts, and progress notes in separate places, FitLah brings them into one dashboard.

The app focuses on four core workflows:

- Track training sessions for push-ups, sit-ups, and runs.
- Use webcam-based pose detection to count push-up and sit-up reps, with first-rep benchmarking so counting adapts to each user's movement range.
- Connect Strava to import recent running activities and evaluate 2.4km readiness.
- Review progress through dashboards, calendar records, personal bests, groups, and optional AI coaching.

## Problem Statement

IPPT preparation is often fragmented. Users may record runs in Strava, count bodyweight exercises manually, and track personal bests separately. This makes it harder to see whether training is improving across all stations.

FitLah solves this by combining exercise capture, run import, scoring context, and progress review into a single local-first app that can be demoed from a laptop.

## Target Users

- NSmen preparing for IPPT.
- Students or fitness users training for push-ups, sit-ups, and 2.4km runs.
- Coaches or group leaders who want simple visibility into training activity.
- Hackathon judges evaluating a working full-stack fitness prototype.

## Main Features

- Account signup and login.
- Dashboard with personal bests and recent activity.
- Webcam push-up and sit-up session logging with MediaPipe pose detection.
- Forgiving rep counting for demos and real users: the first valid rep becomes a per-session benchmark for later push-up depth or sit-up height.
- Calendar-based activity history.
- Strava OAuth connection and recent run import.
- 2.4km/IPPT-style run validation from Strava activity streams.
- Group and invite flows for shared training.
- Optional AI coaching through OpenRouter.
- Cloudflare Tunnel support for temporary public demos.

## Demo Flow

For judging, a typical demo can follow this order:

1. Launch the app locally and sign in.
2. Show the dashboard, personal best cards, and recent activity.
3. Start a webcam push-up or sit-up session and save the result. The first counted rep calibrates the session, then later reps are scored against that movement benchmark.
4. Open the calendar to show the saved activity.
5. Connect Strava, import a recent run, and run the 2.4km analysis.
6. Show AI or fallback coaching recommendations.
7. Open group features to show the collaborative training angle.

## Documentation

For a complete friend handoff, use [`instructions.txt`](instructions.txt). It includes PostgreSQL, Strava API, Cloudflare tunnel, and troubleshooting steps.

For an architecture and dependency overview, see [`docs/TECH_STACK.md`](docs/TECH_STACK.md).

## GitHub Publishing Notes

Before publishing, keep generated local files out of the repository:

- Do not commit `.env`, virtual environments, local database dumps, uploaded user videos, or personal API keys.
- Use `.env.example` as the public template for environment variables.
- Strava Client Secrets and OpenRouter API keys should be added locally through `.env` or the app settings, not hard-coded.
- If you use Cloudflare Tunnel for a demo, the temporary `trycloudflare.com` URL can change every run.

The repository is intended to be publishable as source code plus static lookup data. User recordings and personal database records belong in local runtime storage only.

## Webcam Rep Counting

FitLah uses MediaPipe Pose in the browser for push-up and sit-up sessions.

Push-up counting checks a side-on body profile, arm position, body alignment, and movement depth. The thresholds are intentionally forgiving for hackathon demos and varied camera angles. After the first valid push-up, FitLah stores that rep's elbow depth and shoulder drop as the session benchmark, then accepts later reps that are close to the user's own range.

Sit-up counting checks a side-on torso, hip angle, bent knees, and grounded feet. After the first valid sit-up, FitLah stores that rep's down and up hip-angle range, then uses it to make later reps easier to score for the same user and camera setup.

## Quick Start

Open PowerShell in the project folder:

```powershell
cd "C:\Users\YOUR_NAME\Documents\CODE_EXP_FITLAH_2026"
```

Create and activate a Python virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Install dependencies:

```powershell
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Create a PostgreSQL database named `fitlah`. See [`docs/POSTGRES_SETUP.md`](docs/POSTGRES_SETUP.md) for the full database walkthrough.

Copy the sample environment file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set your PostgreSQL password:

```env
DATABASE_URL=postgresql://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/fitlah
FITLAH_SECRET_KEY=replace-with-a-long-random-secret
```

Start the app:

```powershell
python app.py
```

Open:

```text
http://127.0.0.1:5000
```

Keep the terminal running while using the app.

## Strava Setup

Create a Strava API app at:

```text
https://www.strava.com/settings/api
```

Use:

```text
Website: http://127.0.0.1:5000
Authorization Callback Domain for local testing: 127.0.0.1
Authorization Callback Domain for Cloudflare tunnel testing: trycloudflare.com
```

Strava wants only the domain in the callback field. Do not include `https://`, `/strava-sync`, or a trailing slash.

After saving, copy the Strava Client ID and Client Secret into FitLah:

```text
FitLah -> Settings -> Strava ID / Client secret
```

## Cloudflare Tunnel Testing

For hackathon testing with other users, keep this in `.env`:

```env
FITLAH_PUBLIC_BASE_URL=auto
FITLAH_ALLOWED_ORIGINS=http://localhost:5000,http://127.0.0.1:5000,https://*.trycloudflare.com
```

Start Flask first:

```powershell
python app.py
```

In a second PowerShell terminal, expose the local app:

```powershell
cloudflared tunnel --url http://127.0.0.1:5000
```

Open the `https://...trycloudflare.com` URL that Cloudflare prints. The app will generate Strava redirect URLs from the current tunnel host automatically.

## Optional AI Coaching

The app runs without OpenRouter. To enable live AI responses, add:

```env
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_TIMEOUT_SECONDS=30
OPENROUTER_SITE_URL=http://127.0.0.1:5000
OPENROUTER_APP_NAME=FitLah
```

Restart `python app.py` after changing `.env`.

## Troubleshooting

If `python` is not found, install Python 3.11 or newer and tick "Add Python to PATH" during installation.

If database connection fails, confirm PostgreSQL is running, the database is named `fitlah`, and `.env` has the correct `DATABASE_URL`.

If Strava says `redirect_uri` is invalid, confirm the Strava Authorization Callback Domain matches how you opened the app:

```text
127.0.0.1 for local browser testing
trycloudflare.com for temporary Cloudflare tunnel testing
```

If Strava redirects to `127.0.0.1` while using Cloudflare, confirm `.env` has `FITLAH_PUBLIC_BASE_URL=auto`, restart Flask, open the Cloudflare URL, then click Connect with Strava.

If port `5000` is already in use, stop the other Flask process or run it on another port.
