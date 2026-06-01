"""
Cleanup/migration helper: align Strava-related app_settings and connections.

Actions:
- If `strava_api_key` exists and `strava_client_secret` is empty, promote api_key -> client_secret.
- If `strava_user_id` exists and `strava_client_id` is empty, promote user_id -> client_id.
- Delete legacy settings keys: `strava_api_key`, `strava_user_id`, `strava_redirect_uri`.
- If `strava_client_id` exists, populate empty `athlete_id` in `strava_connections` with it.
- Never copies app client secrets into user access tokens.

Run with the project's environment:

    python -m fitlah.maintenance.cleanup_strava_settings

"""
from fitlah.data_access.database import ensure_tables, session_scope
from fitlah.data_access.repositories import get_settings, set_setting, get_setting
from sqlalchemy import text


def main():
    ensure_tables()

    cfg = get_settings([
        "strava_client_secret",
        "strava_api_key",
        "strava_client_id",
        "strava_user_id",
        "strava_redirect_uri",
    ])

    api_key = cfg.get("strava_api_key")
    client_secret = cfg.get("strava_client_secret")
    user_id = cfg.get("strava_user_id")
    client_id = cfg.get("strava_client_id")

    if api_key and not client_secret:
        print("Promoting 'strava_api_key' -> 'strava_client_secret'")
        set_setting("strava_client_secret", api_key)

    if user_id and not client_id:
        print("Promoting 'strava_user_id' -> 'strava_client_id'")
        set_setting("strava_client_id", user_id)

    # Delete legacy keys
    delete_keys = ["strava_api_key", "strava_user_id", "strava_redirect_uri"]
    deleted_total = 0
    with session_scope() as conn:
        for key in delete_keys:
            res = conn.execute(text("DELETE FROM app_settings WHERE key = :key"), {"key": key})
            count = res.rowcount or 0
            if count:
                print(f"Deleted {count} row(s) for key '{key}'")
            deleted_total += count

        # Refresh read values after any set_setting calls
        current_client_id = get_setting("strava_client_id")

        # Populate empty athlete_id with client id
        if current_client_id:
            res = conn.execute(text(
                "UPDATE strava_connections SET athlete_id = :cid WHERE athlete_id IS NULL OR athlete_id = ''"
            ), {"cid": current_client_id})
            if res.rowcount:
                print(f"Updated {res.rowcount} strava_connections.athlete_id rows using client id")

    print(f"Cleanup complete. Deleted {deleted_total} legacy setting row(s).")


if __name__ == '__main__':
    main()
