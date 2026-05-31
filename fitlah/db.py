import json
import os

from dotenv import load_dotenv
from flask import g

from .config import BASE_DIR, SEEDDATA_DIR

DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/fitlah"
_SCHEMA_READY = False

TABLE_NAMES = [
    "user",
    "workout",
    "webcam",
    "workout_sessions",
    "group_invite",
    "fitness_group",
    "group_member",
    "performance_log",
    "auth_user",
    "personal_best",
    "strava_token",
    "app_setting",
]

TABLES = {
    "auth_user": {
        "db_table": "auth_user",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "nric": "TEXT UNIQUE",
            "password_hash": "TEXT",
            "password_is_default": "BOOLEAN",
            "name": "TEXT",
            "rank": "TEXT",
            "unit": "TEXT",
            "age": "INTEGER",
            "age_group": "TEXT",
            "created_at": "TEXT",
            "last_login": "TEXT",
        },
    },
    "user": {
        "db_table": "app_user",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "nric": "TEXT UNIQUE",
            "name": "TEXT",
            "rank": "TEXT",
            "unit": "TEXT",
            "age": "INTEGER",
            "age_group": "TEXT",
            "last_login": "TEXT",
        },
    },
    "workout": {
        "db_table": "workout",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "name": "TEXT",
            "type": "TEXT",
            "description": "TEXT",
        },
    },
    "webcam": {
        "db_table": "webcam",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "nric": "TEXT",
            "exercise": "TEXT",
            "created_at": "TEXT",
        },
    },
    "workout_sessions": {
        "db_table": "workout_sessions",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "nric": "TEXT",
            "exercise": "TEXT",
            "exercise_label": "TEXT",
            "valid_reps": "INTEGER",
            "invalid_reps": "INTEGER",
            "duration_seconds": "INTEGER",
            "started_at": "TEXT",
            "ended_at": "TEXT",
            "video_file": "TEXT",
            "video_path": "TEXT",
            "personal_best": "INTEGER",
            "date": "TEXT",
            "time": "TEXT",
            "source": "TEXT",
            "ai_recommendation": "JSONB",
        },
    },
    "fitness_group": {
        "db_table": "fitness_group",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "name": "TEXT",
            "created_by": "TEXT",
            "created_date": "TEXT",
        },
    },
    "group_member": {
        "db_table": "group_member",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "group_id": "INTEGER",
            "nric": "TEXT",
            "name": "TEXT",
            "rank": "TEXT",
            "age": "INTEGER",
            "age_group": "TEXT",
            "pushups": "INTEGER",
            "situps": "INTEGER",
            "run_time": "TEXT",
        },
    },
    "group_invite": {
        "db_table": "group_invite",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "sender": "TEXT",
            "sender_nric": "TEXT",
            "recipient_nric": "TEXT",
            "recipient_name": "TEXT",
            "group_id": "INTEGER",
            "group_name": "TEXT",
            "invited_on": "TEXT",
            "status": "TEXT",
        },
    },
    "performance_log": {
        "db_table": "performance_log",
        "columns": {
            "id": "INTEGER PRIMARY KEY",
            "nric": "TEXT",
            "event": "TEXT",
            "name": "TEXT",
            "type": "TEXT",
            "score": "TEXT",
            "time": "TEXT",
            "date": "TEXT",
            "notes": "TEXT",
            "exercise": "TEXT",
            "valid_reps": "INTEGER",
            "invalid_reps": "INTEGER",
            "duration_seconds": "INTEGER",
            "video_path": "TEXT",
            "session_id": "INTEGER",
            "ai_recommendation": "JSONB",
        },
    },
    "personal_best": {
        "db_table": "personal_best",
        "columns": {
            "nric": "TEXT PRIMARY KEY",
            "pushups": "INTEGER",
            "situps": "INTEGER",
            "run_time": "TEXT",
            "age": "INTEGER",
            "age_group": "TEXT",
            "updated_at": "TEXT",
        },
    },
    "strava_token": {
        "db_table": "strava_token",
        "columns": {
            "nric": "TEXT PRIMARY KEY",
            "athlete_id": "TEXT",
            "access_token": "TEXT",
            "refresh_token": "TEXT",
            "expires_at": "INTEGER",
            "scope": "TEXT",
            "updated_at": "TEXT",
        },
    },
    "app_setting": {
        "db_table": "app_setting",
        "columns": {
            "key": "TEXT PRIMARY KEY",
            "value": "TEXT",
            "updated_at": "TEXT",
        },
    },
}


def _driver():
    import psycopg2
    from psycopg2.extras import Json, RealDictCursor

    return psycopg2, Json, RealDictCursor


def _connect():
    psycopg2, _, _ = _driver()
    load_dotenv(os.path.join(BASE_DIR, ".env"))
    database_url = os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)
    return psycopg2.connect(database_url)


def _table_path(table_name):
    return os.path.join(SEEDDATA_DIR, f"{table_name}.json")


def _load_seed_data():
    data = {}
    for table in TABLE_NAMES:
        path = _table_path(table)
        if os.path.exists(path):
            with open(path, "r") as file:
                data[table] = json.load(file)
        else:
            data[table] = []
    return data


def _known_columns(table_name):
    return TABLES[table_name]["columns"]


def _order_column(table_name):
    columns = TABLES[table_name]["columns"]
    if "id" in columns:
        return "id"
    if "nric" in columns:
        return "nric"
    return next(iter(columns))


def _serialize_row(table_name, row):
    columns = _known_columns(table_name)
    extra_data = {key: value for key, value in row.items() if key not in columns}
    values = {}

    for column in columns:
        value = row.get(column)
        if columns[column] == "JSONB" and value is not None:
            _, Json, _ = _driver()
            value = Json(value)
        values[column] = value

    _, Json, _ = _driver()
    values["data"] = Json(extra_data)
    return values


def _deserialize_row(row):
    row = dict(row)
    extra_data = row.pop("data", None) or {}
    row.update(extra_data)
    return row


def ensure_tables():
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return

    with _connect() as conn:
        with conn.cursor() as cursor:
            for config in TABLES.values():
                db_table = config["db_table"]
                column_defs = [
                    f"{column} {column_type}"
                    for column, column_type in config["columns"].items()
                ]
                column_defs.append("data JSONB NOT NULL DEFAULT '{}'::jsonb")
                cursor.execute(
                    f"CREATE TABLE IF NOT EXISTS {db_table} ({', '.join(column_defs)})"
                )
                for column, column_type in config["columns"].items():
                    cursor.execute(
                        f"ALTER TABLE {db_table} ADD COLUMN IF NOT EXISTS {column} {column_type}"
                    )
                cursor.execute(
                    f"ALTER TABLE {db_table} ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{{}}'::jsonb"
                )
    _SCHEMA_READY = True


def load_db():
    ensure_tables()
    data = {}
    _, _, RealDictCursor = _driver()
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            for table_name in TABLE_NAMES:
                config = TABLES[table_name]
                order_column = _order_column(table_name)
                cursor.execute(
                    f"SELECT * FROM {config['db_table']} ORDER BY {order_column}"
                )
                data[table_name] = [_deserialize_row(row) for row in cursor.fetchall()]
    return data


def fetch_table(table_name):
    ensure_tables()
    _, _, RealDictCursor = _driver()
    config = TABLES[table_name]
    order_column = _order_column(table_name)
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(f"SELECT * FROM {config['db_table']} ORDER BY {order_column}")
            return [_deserialize_row(row) for row in cursor.fetchall()]


def next_id(table_name):
    config = TABLES[table_name]
    if "id" not in config["columns"]:
        raise ValueError(f"{table_name} does not use integer ids")

    ensure_tables()
    with _connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT COALESCE(MAX(id), 0) + 1 FROM {config['db_table']}")
            return cursor.fetchone()[0]


def insert_row(table_name, row):
    ensure_tables()
    config = TABLES[table_name]
    columns = [*config["columns"].keys(), "data"]
    values = _serialize_row(table_name, row)
    placeholders = ", ".join(["%s"] * len(columns))

    with _connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                f"INSERT INTO {config['db_table']} ({', '.join(columns)}) VALUES ({placeholders})",
                [values.get(column) for column in columns],
            )
    return row


def update_row(table_name, key_column, key_value, updates):
    ensure_tables()
    config = TABLES[table_name]
    existing = next(
        (row for row in fetch_table(table_name) if row.get(key_column) == key_value),
        None,
    )
    if not existing:
        return False

    existing.update(updates)
    columns = [*config["columns"].keys(), "data"]
    values = _serialize_row(table_name, existing)
    assignments = ", ".join([f"{column} = %s" for column in columns])

    with _connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                f"UPDATE {config['db_table']} SET {assignments} WHERE {key_column} = %s",
                [values.get(column) for column in columns] + [key_value],
            )
    return True


def upsert_row(table_name, key_column, row):
    if update_row(table_name, key_column, row.get(key_column), row):
        return row
    return insert_row(table_name, row)


def delete_row(table_name, key_column, key_value):
    ensure_tables()
    config = TABLES[table_name]
    with _connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                f"DELETE FROM {config['db_table']} WHERE {key_column} = %s",
                [key_value],
            )
            return cursor.rowcount


def delete_rows(table_name, predicate):
    rows = fetch_table(table_name)
    deleted = 0
    for row in rows:
        if predicate(row):
            key_column = _order_column(table_name)
            deleted += delete_row(table_name, key_column, row.get(key_column))
    return deleted


def save_db(data):
    ensure_tables()
    with _connect() as conn:
        with conn.cursor() as cursor:
            for table_name in TABLE_NAMES:
                config = TABLES[table_name]
                db_table = config["db_table"]
                columns = [*config["columns"].keys(), "data"]

                cursor.execute(f"DELETE FROM {db_table}")
                for row in data.get(table_name, []):
                    values = _serialize_row(table_name, row)
                    placeholders = ", ".join(["%s"] * len(columns))
                    cursor.execute(
                        f"INSERT INTO {db_table} ({', '.join(columns)}) VALUES ({placeholders})",
                        [values.get(column) for column in columns],
                    )


def initialize_database(schema_steps):
    ensure_tables()
    db = load_db()
    seed_tables = [table for table in TABLE_NAMES if table != "app_setting"]
    if any(db[table] for table in seed_tables):
        return

    existing_settings = db.get("app_setting", [])
    db = _load_seed_data()
    db["app_setting"] = existing_settings
    for step in schema_steps:
        step(db)
    save_db(db)


def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = load_db()
        g._database = db
    return db


def close_db(exception=None):
    g.pop("_database", None)


def query_db(table, where=None):
    rows = fetch_table(table)
    if where:
        rows = [row for row in rows if where(row)]
    return rows
