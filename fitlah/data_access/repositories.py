import json
from decimal import Decimal
from datetime import datetime, timezone

from sqlalchemy import text

from .database import decrypt_value, encrypt_value, ensure_tables, session_scope
from ..domain.ippt_scoring import format_run_time, parse_run_time


def _clean(row):
    if not row:
        return None
    data = dict(row)
    for key, value in data.items():
        if isinstance(value, datetime):
            data[key] = value.strftime("%Y-%m-%d %H:%M:%S")
        elif isinstance(value, Decimal):
            data[key] = float(value)
    return data


def _all(result):
    return [_clean(row._mapping) for row in result]


def _one(conn, sql, params=None):
    item = conn.execute(text(sql), params or {}).mappings().first()
    return _clean(item)


def _run_seconds(value):
    return parse_run_time(str(value or "")) or None


def _run_time(seconds):
    return format_run_time(seconds) if seconds else "--:--"


def _estimated_24_time(row):
    try:
        distance_km = float(row.get("distance_km") or 0)
        run_seconds = int(row.get("run_time_seconds") or row.get("moving_time") or 0)
    except (TypeError, ValueError):
        return ""
    if distance_km < 2.4 or run_seconds <= 0:
        return ""
    return format_run_time(round(run_seconds * (2.4 / distance_km)))


def _date(value):
    if not value:
        return datetime.now().strftime("%Y-%m-%d")
    return str(value).split(" ")[0]


def _timestamp(date_value=None, time_value=None):
    raw = str(date_value or "").replace("T", " ").replace("Z", "")
    if time_value and len(str(time_value).split(":")) in {2, 3} and "min" not in str(time_value):
        raw = f"{raw.split(' ')[0]} {time_value}"
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw[:len(fmt)], fmt)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _exercise(value):
    value = (value or "").lower()
    if "push" in value:
        return "pushup"
    if "sit" in value:
        return "situp"
    return "run" if value == "run" else value if value in {"pushup", "situp"} else "run"


def _source(value, exercise=None):
    value = (value or "").lower()
    if value in {"webcam", "manual", "strava"}:
        return value
    if value.startswith("webcam") or exercise in {"pushup", "situp"}:
        return "webcam"
    return "manual"


def next_id(table):
    ensure_tables()
    if table not in {"users", "workouts", "fitness_groups", "group_members", "group_invites", "activity_records", "strava_ippt_results"}:
        raise ValueError("Unsupported table.")
    with session_scope() as conn:
        return conn.execute(text(f"SELECT nextval(pg_get_serial_sequence('{table}', 'id'))")).scalar_one()


def get_user(nric):
    ensure_tables()
    with session_scope() as conn:
        return _one(conn, "SELECT * FROM users WHERE nric = :nric", {"nric": (nric or "").upper()})


def list_users():
    ensure_tables()
    with session_scope() as conn:
        return _all(conn.execute(text("SELECT * FROM users ORDER BY id")))


def save_user(user):
    ensure_tables()
    data = {
        "id": user.get("id"),
        "nric": (user.get("nric") or "").upper(),
        "password_hash": user.get("password_hash") or "",
        "password_is_default": bool(user.get("password_is_default")),
        "name": user.get("name") or "NSman",
        "rank": user.get("rank") or "Soldier",
        "unit": user.get("unit") or "UNASSIGNED",
        "age": user.get("age"),
        "age_group": user.get("age_group"),
    }
    with session_scope() as conn:
        if data["id"]:
            conn.execute(text("""
                INSERT INTO users (id, nric, password_hash, password_is_default, name, rank, unit, age, age_group)
                VALUES (:id, :nric, :password_hash, :password_is_default, :name, :rank, :unit, :age, :age_group)
                ON CONFLICT (nric) DO UPDATE SET
                    password_hash = EXCLUDED.password_hash,
                    password_is_default = EXCLUDED.password_is_default,
                    name = EXCLUDED.name,
                    rank = EXCLUDED.rank,
                    unit = EXCLUDED.unit,
                    age = EXCLUDED.age,
                    age_group = EXCLUDED.age_group
            """), data)
        else:
            data["id"] = conn.execute(text("""
                INSERT INTO users (nric, password_hash, password_is_default, name, rank, unit, age, age_group)
                VALUES (:nric, :password_hash, :password_is_default, :name, :rank, :unit, :age, :age_group)
                ON CONFLICT (nric) DO UPDATE SET
                    name = EXCLUDED.name,
                    rank = EXCLUDED.rank,
                    unit = EXCLUDED.unit,
                    age = EXCLUDED.age,
                    age_group = EXCLUDED.age_group
                RETURNING id
            """), data).scalar_one()
    return {**user, **data}


def update_user(nric, updates):
    user = get_user(nric)
    if not user:
        return False
    save_user({**user, **updates, "nric": nric})
    return True


def update_last_login(nric):
    ensure_tables()
    with session_scope() as conn:
        conn.execute(text("UPDATE users SET last_login_at = now() WHERE nric = :nric"), {"nric": nric})


def list_workouts():
    ensure_tables()
    with session_scope() as conn:
        return _all(conn.execute(text("SELECT * FROM workouts ORDER BY id")))


def get_setting(key, default=""):
    ensure_tables()
    with session_scope() as conn:
        setting = _one(conn, "SELECT * FROM app_settings WHERE key = :key", {"key": key})
    if not setting:
        return default
    return decrypt_value(setting["value_encrypted"]) if setting["is_secret"] else setting["value_plain"] or default


def get_settings(keys):
    return {key: get_setting(key) for key in keys}


def set_setting(key, value):
    is_secret = any(part in key.lower() for part in ["secret", "token", "key"])
    with session_scope() as conn:
        conn.execute(text("""
            INSERT INTO app_settings (key, value_plain, value_encrypted, is_secret, updated_at)
            VALUES (:key, :plain, :encrypted, :secret, now())
            ON CONFLICT (key) DO UPDATE SET
                value_plain = EXCLUDED.value_plain,
                value_encrypted = EXCLUDED.value_encrypted,
                is_secret = EXCLUDED.is_secret,
                updated_at = now()
        """), {
            "key": key,
            "plain": "" if is_secret else value,
            "encrypted": encrypt_value(value) if is_secret else "",
            "secret": is_secret,
        })


def personal_best(nric):
    ensure_tables()
    with session_scope() as conn:
        best = _one(conn, """
            SELECT u.nric, COALESCE(pb.pushups, 0) pushups, COALESCE(pb.situps, 0) situps,
                   pb.run_time_seconds, u.age, u.age_group,
                   to_char(pb.updated_at, 'YYYY-MM-DD') updated_at
            FROM users u
            LEFT JOIN personal_bests pb ON pb.user_id = u.id
            WHERE u.nric = :nric
        """, {"nric": nric})
    if not best:
        return None
    best["run_time"] = _run_time(best.pop("run_time_seconds"))
    return best


def save_personal_best(nric, updates):
    ensure_tables()
    user = get_user(nric)
    if not user:
        return
    with session_scope() as conn:
        conn.execute(text("""
            INSERT INTO personal_bests (user_id, pushups, situps, run_time_seconds, updated_at)
            VALUES (:user_id, :pushups, :situps, :run_time_seconds, now())
            ON CONFLICT (user_id) DO UPDATE SET
                pushups = EXCLUDED.pushups,
                situps = EXCLUDED.situps,
                run_time_seconds = EXCLUDED.run_time_seconds,
                updated_at = now()
        """), {
            "user_id": user["id"],
            "pushups": int(updates.get("pushups") or 0),
            "situps": int(updates.get("situps") or 0),
            "run_time_seconds": _run_seconds(updates.get("run_time")),
        })


def recalculate_personal_best(nric):
    """Rebuild one user's personal bests from saved station records."""
    ensure_tables()
    user = get_user(nric)
    if not user:
        return None

    with session_scope() as conn:
        row = _one(conn, """
            SELECT
                COALESCE((
                    SELECT MAX(valid_reps)
                    FROM activity_records
                    WHERE user_id = :user_id AND exercise = 'pushup'
                ), 0) AS pushups,
                COALESCE((
                    SELECT MAX(valid_reps)
                    FROM activity_records
                    WHERE user_id = :user_id AND exercise = 'situp'
                ), 0) AS situps,
                LEAST(
                    COALESCE((
                        SELECT MIN(official_time_seconds)
                        FROM strava_ippt_results
                        WHERE user_id = :user_id
                          AND status = 'valid'
                    ), 2147483647),
                    COALESCE((
                        SELECT MIN(run_time_seconds)
                        FROM activity_records
                        WHERE user_id = :user_id
                          AND exercise = 'run'
                          AND source <> 'strava'
                          AND run_time_seconds IS NOT NULL
                    ), 2147483647)
                ) AS run_time_seconds
        """, {"user_id": user["id"]})
        run_time_seconds = (row or {}).get("run_time_seconds")
        if run_time_seconds == 2147483647:
            run_time_seconds = None

        conn.execute(text("""
            INSERT INTO personal_bests (user_id, pushups, situps, run_time_seconds, updated_at)
            VALUES (:user_id, :pushups, :situps, :run_time_seconds, now())
            ON CONFLICT (user_id) DO UPDATE SET
                pushups = EXCLUDED.pushups,
                situps = EXCLUDED.situps,
                run_time_seconds = EXCLUDED.run_time_seconds,
                updated_at = now()
        """), {
            "user_id": user["id"],
            "pushups": int((row or {}).get("pushups") or 0),
            "situps": int((row or {}).get("situps") or 0),
            "run_time_seconds": run_time_seconds,
        })

    return personal_best(nric)


def activity_records(nric):
    ensure_tables()
    with session_scope() as conn:
        rows = _all(conn.execute(text("""
            SELECT ar.*, u.nric,
                   sir.official_time AS strava_official_time,
                   sir.official_time_seconds AS strava_official_time_seconds,
                   sir.run_points AS strava_run_points,
                   sir.status AS strava_status
            FROM activity_records ar
            JOIN users u ON u.id = ar.user_id
            LEFT JOIN strava_ippt_results sir
              ON sir.user_id = ar.user_id
             AND (
                sir.activity_record_id = ar.id
                OR sir.strava_activity_id = ar.source_external_id
             )
            WHERE u.nric = :nric
            ORDER BY ar.id
        """), {"nric": nric}))
    return [_activity_view(row) for row in rows]


def _activity_view(row):
    exercise = row.get("exercise")
    time_value = ""
    official_time = row.get("strava_official_time")
    if exercise == "run":
        time_value = _run_time(row.get("run_time_seconds"))
    elif row.get("duration_seconds") is not None:
        time_value = f"{int(row['duration_seconds']) // 60}:{int(row['duration_seconds']) % 60:02d} min"
    calendar_run_time = official_time or (_estimated_24_time(row) if exercise == "run" else "")
    return {
        **row,
        "event": row["title"],
        "name": row["title"],
        "type": exercise,
        "date": _date(row.get("logged_at")),
        "time": time_value,
        "official_time": official_time,
        "official_time_seconds": row.get("strava_official_time_seconds"),
        "calendar_run_time": calendar_run_time,
        "run_points": row.get("strava_run_points"),
        "run_status": row.get("strava_status"),
    }


def create_activity(record):
    ensure_tables()
    user = get_user(record.get("nric"))
    if not user:
        return record
    exercise = _exercise(record.get("exercise") or record.get("type"))
    source = _source(record.get("source"), exercise)
    run_time_seconds = record.get("run_time_seconds") or (_run_seconds(record.get("time")) if exercise == "run" else None)
    activity_started_at = record.get("started_at") or (record.get("start_date_local") if source == "strava" else None)
    activity_logged_at = record.get("logged_at") or (record.get("start_date_local") if source == "strava" else None) or record.get("date")
    with session_scope() as conn:
        record["id"] = conn.execute(text("""
            INSERT INTO activity_records (
                user_id, exercise, source, title, score, valid_reps, invalid_reps,
                duration_seconds, run_time_seconds, distance_km, moving_time, elapsed_time,
                pace, started_at, ended_at, logged_at, video_file, video_path,
                is_personal_best, source_external_id, notes, ai_recommendation
            )
            VALUES (
                :user_id, :exercise, :source, :title, :score, :valid_reps, :invalid_reps,
                :duration_seconds, :run_time_seconds, :distance_km, :moving_time, :elapsed_time,
                :pace, :started_at, :ended_at, :logged_at, :video_file, :video_path,
                :is_personal_best, :source_external_id, :notes, CAST(:ai_recommendation AS JSONB)
            )
            RETURNING id
        """), {
            "user_id": user["id"],
            "exercise": exercise,
            "source": source,
            "title": record.get("title") or record.get("name") or record.get("event") or "Training Activity",
            "score": record.get("score"),
            "valid_reps": record.get("valid_reps"),
            "invalid_reps": record.get("invalid_reps"),
            "duration_seconds": record.get("duration_seconds"),
            "run_time_seconds": run_time_seconds,
            "distance_km": record.get("distance_km"),
            "moving_time": record.get("moving_time"),
            "elapsed_time": record.get("elapsed_time"),
            "pace": record.get("pace"),
            "started_at": activity_started_at or None,
            "ended_at": record.get("ended_at") or None,
            "logged_at": _timestamp(activity_logged_at, None),
            "video_file": record.get("video_file"),
            "video_path": record.get("video_path"),
            "is_personal_best": bool(record.get("is_personal_best")),
            "source_external_id": record.get("source_external_id"),
            "notes": record.get("notes"),
            "ai_recommendation": json.dumps(record.get("ai_recommendation")) if record.get("ai_recommendation") else None,
        }).scalar_one()
    return record


def update_strava_activity_record(nric, activity_id, record):
    ensure_tables()
    user = get_user(nric)
    if not user:
        return None
    run_time_seconds = record.get("run_time_seconds") or _run_seconds(record.get("time"))
    started_at = record.get("started_at") or record.get("start_date_local") or record.get("start_date")
    logged_at = record.get("logged_at") or record.get("start_date_local") or record.get("date")
    with session_scope() as conn:
        row = _one(conn, """
            UPDATE activity_records
            SET title = :title,
                score = :score,
                run_time_seconds = :run_time_seconds,
                distance_km = :distance_km,
                moving_time = :moving_time,
                elapsed_time = :elapsed_time,
                pace = :pace,
                started_at = :started_at,
                logged_at = :logged_at,
                notes = :notes,
                ai_recommendation = COALESCE(CAST(:ai_recommendation AS JSONB), ai_recommendation)
            WHERE user_id = :user_id
              AND source = 'strava'
              AND source_external_id = :activity_id
            RETURNING *
        """, {
            "user_id": user["id"],
            "activity_id": str(activity_id),
            "title": record.get("title") or record.get("name") or record.get("event") or "Strava Run",
            "score": record.get("score"),
            "run_time_seconds": run_time_seconds,
            "distance_km": record.get("distance_km"),
            "moving_time": record.get("moving_time"),
            "elapsed_time": record.get("elapsed_time"),
            "pace": record.get("pace"),
            "started_at": started_at or None,
            "logged_at": _timestamp(logged_at, None),
            "notes": record.get("notes"),
            "ai_recommendation": json.dumps(record.get("ai_recommendation")) if record.get("ai_recommendation") else None,
        })
    return _activity_view(row) if row else None


def update_strava_activity_ippt_result(nric, activity_id, result):
    ensure_tables()
    user = get_user(nric)
    if not user:
        return None
    official_seconds = int(result.get("official_time_seconds") or 0)
    official_time = result.get("official_time") or _run_time(official_seconds)
    if not official_seconds:
        return None
    with session_scope() as conn:
        row = _one(conn, """
            UPDATE activity_records
            SET run_time_seconds = :run_time_seconds,
                score = :score
            WHERE user_id = :user_id
              AND source = 'strava'
              AND source_external_id = :activity_id
            RETURNING *
        """, {
            "user_id": user["id"],
            "activity_id": str(activity_id),
            "run_time_seconds": official_seconds,
            "score": official_time,
        })
    return _activity_view(row) if row else None


def save_strava_ippt_result(nric, result):
    ensure_tables()
    user = get_user(nric)
    if not user:
        return result

    payload = {
        "user_id": user["id"],
        "activity_record_id": result.get("activity_record_id"),
        "strava_activity_id": str(result.get("strava_activity_id") or ""),
        "official_time_seconds": int(result.get("official_time_seconds") or 0),
        "official_time": result.get("official_time") or "--:--",
        "run_points": int(result.get("run_points") or 0),
        "validity_score": int(result.get("validity_score") or 0),
        "status": result.get("status") or "invalid",
        "extra_distance_m": float(result.get("extra_distance_m") or 0),
        "pacing_trend": result.get("pacing_trend") or "unknown",
        "splits": json.dumps(result.get("splits") or []),
        "validation_flags": json.dumps(result.get("validation_flags") or []),
        "ai_recommendation": json.dumps(result.get("ai_recommendation")) if result.get("ai_recommendation") else None,
    }
    with session_scope() as conn:
        row = _one(conn, """
            INSERT INTO strava_ippt_results (
                user_id, activity_record_id, strava_activity_id, official_time_seconds,
                official_time, run_points, validity_score, status, extra_distance_m,
                pacing_trend, splits, validation_flags, ai_recommendation
            )
            VALUES (
                :user_id, :activity_record_id, :strava_activity_id, :official_time_seconds,
                :official_time, :run_points, :validity_score, :status, :extra_distance_m,
                :pacing_trend, CAST(:splits AS JSONB), CAST(:validation_flags AS JSONB),
                CAST(:ai_recommendation AS JSONB)
            )
            ON CONFLICT (user_id, strava_activity_id) DO UPDATE SET
                activity_record_id = EXCLUDED.activity_record_id,
                official_time_seconds = EXCLUDED.official_time_seconds,
                official_time = EXCLUDED.official_time,
                run_points = EXCLUDED.run_points,
                validity_score = EXCLUDED.validity_score,
                status = EXCLUDED.status,
                extra_distance_m = EXCLUDED.extra_distance_m,
                pacing_trend = EXCLUDED.pacing_trend,
                splits = EXCLUDED.splits,
                validation_flags = EXCLUDED.validation_flags,
                ai_recommendation = EXCLUDED.ai_recommendation,
                created_at = now()
            RETURNING *
        """, payload)
    return _strava_ippt_view(row)


def strava_ippt_result(nric, activity_id):
    ensure_tables()
    user = get_user(nric)
    if not user:
        return None
    with session_scope() as conn:
        row = _one(conn, """
            SELECT *
            FROM strava_ippt_results
            WHERE user_id = :user_id AND strava_activity_id = :activity_id
            ORDER BY created_at DESC
            LIMIT 1
        """, {"user_id": user["id"], "activity_id": str(activity_id)})
    return _strava_ippt_view(row)


def update_strava_ippt_recommendation(nric, activity_id, recommendation):
    ensure_tables()
    user = get_user(nric)
    if not user:
        return None
    with session_scope() as conn:
        row = _one(conn, """
            UPDATE strava_ippt_results
            SET ai_recommendation = CAST(:ai_recommendation AS JSONB)
            WHERE user_id = :user_id AND strava_activity_id = :activity_id
            RETURNING *
        """, {
            "user_id": user["id"],
            "activity_id": str(activity_id),
            "ai_recommendation": json.dumps(recommendation),
        })
    return _strava_ippt_view(row)


def link_strava_ippt_activity_record(nric, activity_id, activity_record_id):
    ensure_tables()
    user = get_user(nric)
    if not user or not activity_record_id:
        return None
    with session_scope() as conn:
        row = _one(conn, """
            UPDATE strava_ippt_results
            SET activity_record_id = :activity_record_id
            WHERE user_id = :user_id AND strava_activity_id = :activity_id
            RETURNING *
        """, {
            "user_id": user["id"],
            "activity_id": str(activity_id),
            "activity_record_id": activity_record_id,
        })
    return _strava_ippt_view(row)


def strava_activity_record(nric, activity_id):
    ensure_tables()
    with session_scope() as conn:
        row = _one(conn, """
            SELECT ar.*
            FROM activity_records ar
            JOIN users u ON u.id = ar.user_id
            WHERE u.nric = :nric
              AND ar.source = 'strava'
              AND ar.source_external_id = :activity_id
            ORDER BY ar.id DESC
            LIMIT 1
        """, {"nric": nric, "activity_id": str(activity_id)})
    return _activity_view(row) if row else None


def _strava_ippt_view(row):
    if not row:
        return None
    for key in ("splits", "validation_flags", "ai_recommendation"):
        if isinstance(row.get(key), str):
            try:
                row[key] = json.loads(row[key])
            except json.JSONDecodeError:
                pass
    return row


def update_activity(record_id, nric, updates):
    values = {}
    sets = []
    if "ai_recommendation" in updates:
        values["ai_recommendation"] = json.dumps(updates["ai_recommendation"])
        sets.append("ai_recommendation = CAST(:ai_recommendation AS JSONB)")
    if not sets:
        return False
    values.update({"id": record_id, "nric": nric})
    with session_scope() as conn:
        result = conn.execute(text(f"""
            UPDATE activity_records ar
            SET {', '.join(sets)}
            FROM users u
            WHERE ar.user_id = u.id AND ar.id = :id AND u.nric = :nric
        """), values)
        return result.rowcount > 0


def delete_activity(record_id, nric):
    with session_scope() as conn:
        result = conn.execute(text("""
            DELETE FROM activity_records ar
            USING users u
            WHERE ar.user_id = u.id AND ar.id = :id AND u.nric = :nric
        """), {"id": record_id, "nric": nric})
        return result.rowcount


def list_groups():
    ensure_tables()
    with session_scope() as conn:
        return _all(conn.execute(text("""
            SELECT g.id, g.name, COALESCE(u.name, 'NSman') created_by,
                   to_char(g.created_at, 'YYYY-MM-DD') created_date
            FROM fitness_groups g
            LEFT JOIN users u ON u.id = g.created_by_user_id
            ORDER BY g.id
        """)))


def create_group(name, creator_nric):
    creator = get_user(creator_nric)
    with session_scope() as conn:
        return conn.execute(text("""
            INSERT INTO fitness_groups (name, created_by_user_id)
            VALUES (:name, :creator)
            RETURNING id
        """), {"name": name, "creator": creator["id"] if creator else None}).scalar_one()


def list_group_members():
    ensure_tables()
    with session_scope() as conn:
        rows = _all(conn.execute(text("""
            SELECT gm.id, gm.group_id, u.nric, u.name, u.rank, u.age, u.age_group,
                   COALESCE(pb.pushups, 0) pushups, COALESCE(pb.situps, 0) situps,
                   pb.run_time_seconds
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            LEFT JOIN personal_bests pb ON pb.user_id = u.id
            ORDER BY gm.id
        """)))
    for item in rows:
        item["run_time"] = _run_time(item.pop("run_time_seconds"))
    return rows


def add_group_member(group_id, nric):
    user = get_user(nric)
    if not user:
        return False
    with session_scope() as conn:
        conn.execute(text("""
            INSERT INTO group_members (group_id, user_id)
            VALUES (:group_id, :user_id)
            ON CONFLICT (group_id, user_id) DO NOTHING
        """), {"group_id": group_id, "user_id": user["id"]})
    return True


def list_invites():
    ensure_tables()
    with session_scope() as conn:
        rows = _all(conn.execute(text("""
            SELECT gi.id, COALESCE(sender.name, 'NSman') sender, sender.nric sender_nric,
                   recipient.nric recipient_nric, recipient.name recipient_name,
                   gi.group_id, fg.name group_name, to_char(gi.invited_at, 'YYYY-MM-DD') invited_on,
                   gi.status
            FROM group_invites gi
            LEFT JOIN users sender ON sender.id = gi.sender_user_id
            JOIN users recipient ON recipient.id = gi.recipient_user_id
            LEFT JOIN fitness_groups fg ON fg.id = gi.group_id
            ORDER BY gi.id
        """)))
    for item in rows:
        item["status"] = item["status"].capitalize()
    return rows


def create_invite(group_id, sender_nric, recipient_nric):
    sender = get_user(sender_nric)
    recipient = get_user(recipient_nric)
    if not recipient:
        return False
    with session_scope() as conn:
        conn.execute(text("""
            INSERT INTO group_invites (group_id, sender_user_id, recipient_user_id)
            VALUES (:group_id, :sender_id, :recipient_id)
        """), {
            "group_id": group_id,
            "sender_id": sender["id"] if sender else None,
            "recipient_id": recipient["id"],
        })
    return True


def update_invite(invite_id, status):
    with session_scope() as conn:
        conn.execute(text("""
            UPDATE group_invites
            SET status = :status, responded_at = CASE WHEN :status IN ('accepted', 'declined') THEN now() ELSE responded_at END
            WHERE id = :id
        """), {"id": invite_id, "status": status.lower()})


def strava_connection(nric):
    user = get_user(nric)
    if not user:
        return None
    with session_scope() as conn:
        row = _one(conn, "SELECT * FROM strava_connections WHERE user_id = :user_id", {"user_id": user["id"]})
    if not row:
        return None
    expires_at = row.get("expires_at")
    if isinstance(expires_at, str):
        try:
            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            expires_at = None

    return {
        "nric": nric,
        "athlete_id": row.get("athlete_id"),
        "access_token": decrypt_value(row.get("access_token_encrypted")),
        "refresh_token": decrypt_value(row.get("refresh_token_encrypted")),
        "expires_at": int(expires_at.timestamp()) if isinstance(expires_at, datetime) else 0,
        "scope": row.get("scope"),
        "updated_at": row.get("updated_at"),
    }


def save_strava_connection(data):
    user = get_user(data.get("nric"))
    if not user:
        return
    expires_at = datetime.fromtimestamp(int(data.get("expires_at")), timezone.utc) if data.get("expires_at") else None
    with session_scope() as conn:
        conn.execute(text("""
            INSERT INTO strava_connections (user_id, athlete_id, access_token_encrypted, refresh_token_encrypted, expires_at, scope, updated_at)
            VALUES (:user_id, :athlete_id, :access_token, :refresh_token, :expires_at, :scope, now())
            ON CONFLICT (user_id) DO UPDATE SET
                athlete_id = EXCLUDED.athlete_id,
                access_token_encrypted = EXCLUDED.access_token_encrypted,
                refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                expires_at = EXCLUDED.expires_at,
                scope = EXCLUDED.scope,
                updated_at = now()
        """), {
            "user_id": user["id"],
            "athlete_id": data.get("athlete_id"),
            "access_token": encrypt_value(data.get("access_token")),
            "refresh_token": encrypt_value(data.get("refresh_token")),
            "expires_at": expires_at,
            "scope": data.get("scope"),
        })


def delete_strava_connection(nric):
    user = get_user(nric)
    if not user:
        return 0
    with session_scope() as conn:
        result = conn.execute(
            text("DELETE FROM strava_connections WHERE user_id = :user_id"),
            {"user_id": user["id"]},
        )
        return result.rowcount or 0
