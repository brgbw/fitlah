import base64
import hashlib
import os
from contextlib import contextmanager

from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv
from flask import g
from sqlalchemy import create_engine, text

from ..core.config import BASE_DIR

_ENGINE = None
_SCHEMA_READY = False


def database_url():
    load_dotenv(os.path.join(BASE_DIR, ".env"))
    value = (os.environ.get("DATABASE_URL") or "").strip()
    if not value:
        raise RuntimeError("DATABASE_URL must be set in .env or the environment.")
    return value


def engine():
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = create_engine(database_url(), future=True, pool_pre_ping=True)
    return _ENGINE


@contextmanager
def session_scope():
    with engine().begin() as conn:
        yield conn


def close_db(exception=None):
    g.pop("_database", None)


def encryption():
    load_dotenv(os.path.join(BASE_DIR, ".env"))
    key = os.environ.get("FIELD_ENCRYPTION_KEY")
    if key:
        try:
            return Fernet(key.encode())
        except (TypeError, ValueError):
            pass
    seed = os.environ.get("FITLAH_SECRET_KEY")
    if not seed:
        raise RuntimeError("Set FIELD_ENCRYPTION_KEY or FITLAH_SECRET_KEY before encrypting secrets.")
    seed = seed.encode()
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(seed).digest()))


def encrypt_value(value):
    if not value:
        return ""
    return encryption().encrypt(str(value).encode()).decode()


def decrypt_value(value):
    if not value:
        return ""
    try:
        return encryption().decrypt(str(value).encode()).decode()
    except (InvalidToken, TypeError, ValueError):
        return ""


def ensure_tables():
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    with session_scope() as conn:
        for statement in SCHEMA:
            conn.execute(text(statement))
    _SCHEMA_READY = True


SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        nric TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        password_is_default BOOLEAN NOT NULL DEFAULT FALSE,
        name TEXT NOT NULL DEFAULT 'NSman',
        rank TEXT NOT NULL DEFAULT 'Soldier',
        unit TEXT NOT NULL DEFAULT 'UNASSIGNED',
        age INTEGER,
        age_group TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_plain TEXT,
        value_encrypted TEXT,
        is_secret BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workouts (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS fitness_groups (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS group_members (
        id BIGSERIAL PRIMARY KEY,
        group_id BIGINT NOT NULL REFERENCES fitness_groups(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(group_id, user_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS group_invites (
        id BIGSERIAL PRIMARY KEY,
        group_id BIGINT REFERENCES fitness_groups(id) ON DELETE CASCADE,
        sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        recipient_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
        invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        responded_at TIMESTAMPTZ
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS personal_bests (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        pushups INTEGER NOT NULL DEFAULT 0,
        situps INTEGER NOT NULL DEFAULT 0,
        run_time_seconds INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS activity_records (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workout_id BIGINT REFERENCES workouts(id) ON DELETE SET NULL,
        exercise TEXT NOT NULL CHECK (exercise IN ('pushup', 'situp', 'run')),
        source TEXT NOT NULL CHECK (source IN ('webcam', 'manual', 'strava')),
        title TEXT NOT NULL,
        score TEXT,
        valid_reps INTEGER,
        invalid_reps INTEGER,
        duration_seconds INTEGER,
        run_time_seconds INTEGER,
        distance_km NUMERIC(6,2),
        moving_time INTEGER,
        elapsed_time INTEGER,
        pace TEXT,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        video_file TEXT,
        video_path TEXT,
        is_personal_best BOOLEAN NOT NULL DEFAULT FALSE,
        source_external_id TEXT,
        notes TEXT,
        ai_recommendation JSONB
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS strava_connections (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        athlete_id TEXT,
        access_token_encrypted TEXT,
        refresh_token_encrypted TEXT,
        expires_at TIMESTAMPTZ,
        scope TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS strava_ippt_results (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        activity_record_id BIGINT REFERENCES activity_records(id) ON DELETE SET NULL,
        strava_activity_id TEXT NOT NULL,
        official_time_seconds INTEGER NOT NULL,
        official_time TEXT NOT NULL,
        run_points INTEGER NOT NULL DEFAULT 0,
        validity_score INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
        extra_distance_m NUMERIC(8,2) NOT NULL DEFAULT 0,
        pacing_trend TEXT NOT NULL,
        splits JSONB NOT NULL,
        validation_flags JSONB NOT NULL,
        ai_recommendation JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, strava_activity_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_users_nric ON users(nric)",
    "CREATE INDEX IF NOT EXISTS idx_activity_user_logged ON activity_records(user_id, logged_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_invites_recipient_status ON group_invites(recipient_user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_strava_ippt_user_created ON strava_ippt_results(user_id, created_at DESC)",
    "DROP INDEX IF EXISTS uq_activity_source_external",
    """
    CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_user_source_external
    ON activity_records(user_id, source, source_external_id)
    WHERE source_external_id IS NOT NULL AND source_external_id <> ''
    """,
    """
    DO $$
    DECLARE
        item record;
    BEGIN
        FOR item IN
            SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            WHERE nsp.nspname = current_schema()
              AND rel.relname = 'strava_ippt_results'
              AND con.contype = 'c'
              AND pg_get_constraintdef(con.oid) LIKE '%status%'
        LOOP
            EXECUTE format('ALTER TABLE strava_ippt_results DROP CONSTRAINT %I', item.conname);
        END LOOP;
    END $$;
    """,
    """
    UPDATE strava_ippt_results
    SET status = CASE WHEN status IN ('verified', 'valid') THEN 'valid' ELSE 'invalid' END
    WHERE status NOT IN ('valid', 'invalid')
    """,
    """
    ALTER TABLE strava_ippt_results
    ADD CONSTRAINT strava_ippt_results_status_check
    CHECK (status IN ('valid', 'invalid'))
    """,
]
