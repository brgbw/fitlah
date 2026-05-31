from datetime import datetime

from .db import query_db, upsert_row


def get_setting(key, default=""):
    row = next((item for item in query_db("app_setting", lambda x: x.get("key") == key)), None)
    if not row:
        return default
    return row.get("value") or default


def get_settings(keys):
    rows = query_db("app_setting", lambda x: x.get("key") in keys)
    values = {row.get("key"): row.get("value") or "" for row in rows}
    return {key: values.get(key, "") for key in keys}


def set_setting(key, value):
    return upsert_row("app_setting", "key", {
        "key": key,
        "value": value,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })
