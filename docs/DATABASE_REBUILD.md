# FitLah Database Rebuild

## Current State

The app now uses one normalized PostgreSQL schema:

- `users`
- `app_settings`
- `workouts`
- `fitness_groups`
- `group_members`
- `group_invites`
- `personal_bests`
- `activity_records`
- `strava_connections`

All database access goes through focused repository functions in `fitlah/repositories.py`.
The Flask app creates the fresh schema at startup through `fitlah/db.py`.

## Implemented

- Unified manual logs, webcam sessions, and Strava runs into `activity_records`.
- Normalized profile and auth data into `users`.
- Stored Strava OAuth/app credentials in the database instead of depending on `.env`.
- Encrypted app secrets and Strava tokens at rest.
- Added foreign keys, unique constraints, check constraints, indexes, and database sequences.
- Removed legacy table helpers, migration files, and old database compatibility code.
- Renamed the activity API to `/api/activity-records`.

## Secret Storage

Encrypted values use `FIELD_ENCRYPTION_KEY` when present. If it is missing, local development derives a key from `FITLAH_SECRET_KEY`.
