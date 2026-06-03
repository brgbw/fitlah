"""
Migration helper: align Strava app settings with per-user connections.

This script will:
- Read the global `strava_client_id` from app settings.
- For each user with an existing `strava_connections` row, if `athlete_id` is empty,
  populate it from the global client id. It never copies app client secrets into user access tokens.

Run with the project's Python environment and required environment variables:

    python -m fitlah.maintenance.migrate_strava_settings

"""
from datetime import datetime

from fitlah.data_access.database import ensure_tables
from fitlah.data_access.repositories import get_settings, list_users, strava_connection, save_strava_connection


def migrate():
    ensure_tables()
    cfg = get_settings(["strava_client_id"])
    client_id = cfg.get("strava_client_id")

    if not client_id:
        print("No global Strava client id found - nothing to migrate.")
        return

    users = list_users()
    updated = 0
    for user in users:
        nric = user.get("nric")
        conn = strava_connection(nric)
        if not conn:
            continue

        need_update = False
        athlete_id = conn.get("athlete_id") or ""

        if not athlete_id and client_id:
            athlete_id = client_id
            need_update = True

        if need_update:
            print(f"Updating Strava connection for {nric}: athlete_id={'(set)' if athlete_id else '(empty)'}")
            save_strava_connection({
                "nric": nric,
                "athlete_id": athlete_id,
                "access_token": conn.get("access_token") or "",
                "refresh_token": conn.get("refresh_token") or "",
                "expires_at": int(conn.get("expires_at") or 0),
                "scope": conn.get("scope") or "",
                "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
            updated += 1

    print(f"Migration complete. Updated {updated} user connection(s).")


if __name__ == "__main__":
    migrate()
