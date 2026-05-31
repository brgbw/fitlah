# FitLah Local Setup

FitLah is a Flask app for IPPT training, webcam session logging, Strava run import, Calendar activity records, groups, and progress graphs.

## Quick Start on Windows

Open PowerShell in the project folder:

```powershell
cd "C:\Users\brand\OneDrive\Documents\Hackathon\CODE_EXP_FITLAH_2026"
```

Create and activate a Python virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, run this once in the same terminal, then activate again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Install dependencies:

```powershell
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Create a PostgreSQL database named `fitlah`, then create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/fitlah
FITLAH_SECRET_KEY=replace-with-a-random-secret
```

Replace `your_password` with your local PostgreSQL password. See [docs/POSTGRES_SETUP.md](docs/POSTGRES_SETUP.md) for a full PostgreSQL walkthrough.

Start the app:

```powershell
python app.py
```

Open:

```text
http://127.0.0.1:5000
```

Keep the terminal running while using the app.

## Optional Features

Strava import requires client credentials saved through the app Settings page. After connecting Strava, recent runs can be imported into Calendar activity records.

AI coaching uses OpenRouter. Without an API key, the app still runs and Strava 2.4km analysis still shows time, status, points, and fallback coaching. To enable live AI responses, add this to `.env`:

```env
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Restart `python app.py` after changing `.env`.

## Common Commands

Activate the venv:

```powershell
.\.venv\Scripts\Activate.ps1
```

Stop the app:

```powershell
Ctrl+C
```

Deactivate the venv:

```powershell
deactivate
```

## Troubleshooting

If `python` is not found, install Python 3.11 or newer and tick "Add Python to PATH" during installation.

If database connection fails, confirm PostgreSQL is running and the `.env` `DATABASE_URL` password/database name are correct.

If port `5000` is already in use, stop the other Flask process or restart the terminal running the app.

If Strava saves but the run does not appear in Calendar, check that you are logged into the same FitLah account that connected Strava, and open the Calendar date that matches the Strava activity date.
