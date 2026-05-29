import os
import json
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, render_template, g, request, jsonify, redirect, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from ai_coach import generate_exercise_recommendation

from db import get_db, close_db, query_db, load_db, save_db, SERVERDATA_DIR

from schema import ensure_auth_tables, ensure_group_invite_schema, ensure_personal_best_data, ensure_performance_log_schema
from auth import current_user, login_required
from helpers import update_personal_best, save_ai_recommendation, attach_ai_to_performance_logs, find_auth_user, find_group, user_is_group_member, get_personal_best, member_with_personal_best, create_invites_for_group

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(__name__, template_folder="templates")
app.secret_key = os.environ.get("FITLAH_SECRET_KEY", "fitlah-dev-secret-key")

@app.teardown_appcontext
def teardown_db(exception):
    close_db(exception)

@app.context_processor
def inject_current_user():
    return {"current_user": current_user()}

def init_db():
    """Initialize database with JSON data if it doesn't exist."""
    os.makedirs(SERVERDATA_DIR, exist_ok=True)

    db = load_db()
    if db is None:
        db = {}

    ensure_auth_tables(db)
    ensure_group_invite_schema(db)
    ensure_personal_best_data(db)
    ensure_performance_log_schema(db)
    save_db(db)

with app.app_context():
    init_db()


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user():
        return redirect(url_for("dashboard"))

    error = None
    if request.method == "POST":
        nric = request.form.get("nric", "").strip().upper()
        password = request.form.get("password", "")
        db = get_db()
        user = next((u for u in db.get("auth_user", []) if u.get("nric") == nric), None)

        if user and check_password_hash(user.get("password_hash", ""), password):
            session["user_nric"] = user["nric"]
            user["last_login"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            return redirect(url_for("dashboard"))

        error = "Invalid NRIC or password."

    return render_template("auth.html", mode="login", error=error)


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user():
        return redirect(url_for("dashboard"))

    error = None
    if request.method == "POST":
        nric = request.form.get("nric", "").strip().upper()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")
        name = request.form.get("name", "").strip()
        rank = request.form.get("rank", "").strip() or "Soldier"
        unit = request.form.get("unit", "").strip() or "Unassigned"

        if not nric or len(nric) < 5:
            error = "Enter a valid NRIC."
        elif not password or len(password) < 6:
            error = "Password must be at least 6 characters."
        elif password != confirm_password:
            error = "Passwords do not match."
        elif not name:
            error = "Enter your name."
        else:
            db = get_db()
            existing = next((u for u in db.get("auth_user", []) if u.get("nric") == nric), None)

            if existing and not existing.get("password_is_default"):
                error = "This NRIC already has an account. Please log in."
            elif existing:
                existing.update({
                    "password_hash": generate_password_hash(password),
                    "password_is_default": False,
                    "name": name,
                    "rank": rank,
                    "unit": unit,
                    "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                })
                session["user_nric"] = nric
                return redirect(url_for("dashboard"))
            else:
                new_user = {
                    "id": max([u.get("id", 0) for u in db.get("auth_user", [])], default=0) + 1,
                    "nric": nric,
                    "password_hash": generate_password_hash(password),
                    "password_is_default": False,
                    "name": name,
                    "rank": rank,
                    "unit": unit,
                    "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "last_login": None
                }
                db.setdefault("auth_user", []).append(new_user)
                db.setdefault("user", []).append({
                    "id": max([u.get("id", 0) for u in db.get("user", [])], default=0) + 1,
                    "nric": nric,
                    "name": name,
                    "rank": rank,
                    "unit": unit,
                    "last_login": None
                })
                session["user_nric"] = nric
                return redirect(url_for("dashboard"))

    return render_template("auth.html", mode="signup", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def dashboard():
    user = current_user()
    workouts = query_db("workout")
    recent_logs = sorted(
        query_db("performance_log", lambda x: x.get("nric") == user.get("nric")),
        key=lambda x: x['id'],
        reverse=True
    )[:3]
    return render_template("dashboard.html", user=user, workouts=workouts, recent_logs=recent_logs)


@app.route("/dashboard-graph")
@login_required
def dashboard_graph():
    return render_template("dashboardgraph.html")


@app.route("/group")
@login_required
def group():
    user = current_user()
    invites = query_db(
        "group_invite",
        lambda x: x.get("recipient_nric") == user.get("nric") and x.get("status") == "Pending"
    )
    joined_group_ids = {
        member.get("group_id")
        for member in query_db("group_member", lambda x: x.get("nric") == user.get("nric"))
    }
    groups = query_db("fitness_group", lambda x: x.get("id") in joined_group_ids)
    
    # Only expose rosters for groups the current user has joined.
    group_data = []
    for group in groups:
        members = sorted(
            [
                member_with_personal_best(member)
                for member in query_db("group_member", lambda x: x.get('group_id') == group.get('id'))
            ],
            key=lambda x: x.get('personal_best', {}).get('pushups', 0),
            reverse=True
        )
        group_data.append({
            'group': group,
            'members': members
        })
    
    return render_template("group_invites.html", invites=invites, group_data=group_data)


@app.route("/api/accept-invite/<int:invite_id>", methods=['POST'])
@login_required
def accept_invite(invite_id):
    db = get_db()
    user = current_user()
    for invite in db['group_invite']:
        if invite['id'] == invite_id and invite.get("recipient_nric") == user.get("nric"):
            invite['status'] = 'Accepted'
            group_id = invite.get("group_id")
            if group_id and not user_is_group_member(group_id, user.get("nric")):
                max_id = max([m['id'] for m in db['group_member']], default=0)
                db['group_member'].append({
                    "id": max_id + 1,
                    "group_id": group_id,
                    "nric": user.get("nric"),
                    "name": user.get("name", "NSman"),
                    "rank": user.get("rank", "Soldier"),
                    "pushups": get_personal_best(user.get("nric")).get("pushups", 0),
                    "situps": get_personal_best(user.get("nric")).get("situps", 0),
                    "run_time": get_personal_best(user.get("nric")).get("run_time", "--:--")
                })
            break
    return jsonify({"success": True})


@app.route("/api/decline-invite/<int:invite_id>", methods=['POST'])
@login_required
def decline_invite(invite_id):
    db = get_db()
    user = current_user()
    for invite in db['group_invite']:
        if invite['id'] == invite_id and invite.get("recipient_nric") == user.get("nric"):
            invite['status'] = 'Declined'
            break
    return jsonify({"success": True})


@app.route("/api/create-group", methods=['POST'])
@login_required
def create_group():
    data = request.get_json()
    group_name = data.get('group_name')
    invited_nrics = data.get('invited_nrics', [])
    
    if not group_name:
        return jsonify({"success": False, "error": "Group name required"}), 400
    
    db = get_db()
    max_id = max([g['id'] for g in db['fitness_group']], default=0)
    new_group = {
        "id": max_id + 1,
        "name": group_name,
        "created_by": current_user().get("name", "NSman"),
        "created_date": datetime.now().strftime("%Y-%m-%d")
    }
    db['fitness_group'].append(new_group)
    created_invites = create_invites_for_group(db, new_group, invited_nrics)
    db['group_member'].append({
        "id": max([m['id'] for m in db['group_member']], default=0) + 1,
        "group_id": new_group["id"],
        "nric": current_user().get("nric"),
        "name": current_user().get("name", "NSman"),
        "rank": current_user().get("rank", "Soldier"),
        "pushups": get_personal_best(current_user().get("nric")).get("pushups", 0),
        "situps": get_personal_best(current_user().get("nric")).get("situps", 0),
        "run_time": get_personal_best(current_user().get("nric")).get("run_time", "--:--")
    })
    return jsonify({"success": True, "group_id": new_group['id'], "invites_created": created_invites})


@app.route("/api/add-member", methods=['POST'])
@login_required
def add_member():
    data = request.get_json()
    group_id = data.get('group_id')
    nric = data.get('nric')
    
    if not all([group_id, nric]):
        return jsonify({"success": False, "error": "Missing required fields"}), 400
    
    db = get_db()
    group = find_group(int(group_id))
    if not group:
        return jsonify({"success": False, "error": "Group not found"}), 404

    created = create_invites_for_group(db, group, [nric])
    if created == 0:
        return jsonify({"success": False, "error": "Invite already exists, user is already in the group, or NRIC is unknown"}), 400

    return jsonify({"success": True, "invites_created": created})


@app.route("/performance")
@login_required
def performance():
    user = current_user()
    logs = sorted(
        query_db("performance_log", lambda x: x.get("nric") == user.get("nric")),
        key=lambda x: x['id'],
        reverse=True
    )
    return render_template("performance_log.html", logs=logs)


@app.route("/api/performance-log", methods=["GET"])
@login_required
def api_performance_logs():
    user = current_user()
    nric = user.get("nric")
    db = get_db()
    logs = sorted(
        query_db("performance_log", lambda x: x.get("nric") == nric),
        key=lambda x: (x.get("date", ""), x.get("id", 0))
    )
    logs = attach_ai_to_performance_logs(db, logs, nric)
    return jsonify({"success": True, "logs": logs})


@app.route("/api/performance-log", methods=["POST"])
@login_required
def api_create_performance_log():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    date = (data.get("date") or "").strip()

    if not name or not date:
        return jsonify({"success": False, "error": "Event name and date are required"}), 400

    db = get_db()
    new_log = {
        "id": max([log.get("id", 0) for log in db.get("performance_log", [])], default=0) + 1,
        "nric": current_user().get("nric"),
        "event": name,
        "name": name,
        "type": data.get("type") or "logged",
        "score": (data.get("score") or "").strip(),
        "time": (data.get("time") or "").strip(),
        "date": date,
        "notes": (data.get("notes") or "").strip()
    }
    db.setdefault("performance_log", []).append(new_log)
    return jsonify({"success": True, "log": new_log}), 201


@app.route("/api/performance-log/<int:log_id>", methods=["DELETE"])
@login_required
def api_delete_performance_log(log_id):
    db = get_db()
    user = current_user()
    before = len(db.get("performance_log", []))
    db["performance_log"] = [
        log for log in db.get("performance_log", [])
        if not (log.get("id") == log_id and log.get("nric") == user.get("nric"))
    ]

    if len(db["performance_log"]) == before:
        return jsonify({"success": False, "error": "Log not found"}), 404

    return jsonify({"success": True})


@app.route("/webcam")
@login_required
def webcam():
    logs = sorted(query_db("webcam"), key=lambda x: x['id'], reverse=True)
    return render_template("webcam.html")


@app.route("/webcam-prep")
@login_required
def webcam_prep():
    return render_template("webcam_prep.html")


def recalculate_exercise_best(db, nric, exercise_type):
    field = "pushups" if exercise_type == "pushup" else "situps"
    best_reps = max(
        [
            int(session.get("valid_reps") or 0)
            for session in db.get("workout_sessions", [])
            if session.get("nric") == nric and session.get("exercise") == exercise_type
        ],
        default=0
    )

    personal_best = next((pb for pb in db.get("personal_best", []) if pb.get("nric") == nric), None)
    if not personal_best:
        personal_best = {
            "nric": nric,
            "pushups": 0,
            "situps": 0,
            "run_time": "--:--",
            "updated_at": None
        }
        db.setdefault("personal_best", []).append(personal_best)

    personal_best[field] = best_reps
    personal_best["updated_at"] = datetime.now().strftime("%Y-%m-%d")

    for member in db.get("group_member", []):
        if member.get("nric") == nric:
            member[field] = best_reps

    return best_reps


def delete_session_video(video_path):
    if not video_path:
        return False

    normalized_path = video_path.replace("\\", "/").lstrip("/")
    absolute_path = os.path.abspath(os.path.join(BASE_DIR, normalized_path))
    userdata_root = os.path.abspath(os.path.join(BASE_DIR, "userdata"))

    if not absolute_path.startswith(userdata_root + os.sep):
        return False

    if os.path.exists(absolute_path):
        os.remove(absolute_path)
        return True

    return False


@app.route("/api/workout-session/<int:session_id>", methods=["DELETE"])
@login_required
def delete_workout_session(session_id):
    db = get_db()
    user = current_user()
    nric = user.get("nric")
    session_record = next(
        (
            item for item in db.get("workout_sessions", [])
            if item.get("id") == session_id and item.get("nric") == nric
        ),
        None
    )

    if not session_record:
        return jsonify({"success": False, "error": "Session not found"}), 404

    exercise_type = session_record.get("exercise")
    video_deleted = delete_session_video(session_record.get("video_path"))

    db["workout_sessions"] = [
        item for item in db.get("workout_sessions", [])
        if not (item.get("id") == session_id and item.get("nric") == nric)
    ]
    db["performance_log"] = [
        log for log in db.get("performance_log", [])
        if not (log.get("session_id") == session_id and log.get("nric") == nric)
    ]

    personal_best = None
    if exercise_type in {"pushup", "situp"}:
        personal_best = recalculate_exercise_best(db, nric, exercise_type)

    return jsonify({
        "success": True,
        "session_id": session_id,
        "video_deleted": video_deleted,
        "personal_best": personal_best
    })



@app.route("/api/upload-video", methods=['POST'])
@login_required
def upload_video():
    if 'video' not in request.files:
        return jsonify({"success": False, "error": "No video file provided"}), 400
    
    file = request.files['video']
    exercise_type = request.form.get('exercise', 'pushup')
    if exercise_type not in {"pushup", "situp"}:
        return jsonify({"success": False, "error": "Invalid exercise type"}), 400

    valid_reps = min(int(request.form.get('valid_reps', 0) or 0), 120)
    invalid_reps = min(int(request.form.get('invalid_reps', 0) or 0), 120)
    duration_seconds = min(int(request.form.get('duration_seconds', 60) or 60), 120)
    started_at = request.form.get('started_at', '')
    ended_at = request.form.get('ended_at', datetime.now().isoformat())
    
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400
        
    if file:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{exercise_type}_{timestamp}.webm"
        
        folder = "pushup_videos" if exercise_type == 'pushup' else "situp_videos"
        relative_video_path = os.path.join('userdata', folder, filename)
        save_path = os.path.join(BASE_DIR, relative_video_path)
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        
        file.save(save_path)
        db = get_db()
        user = current_user()
        nric = user.get("nric")
        update_personal_best(nric, exercise_type, valid_reps)
        best = get_personal_best(nric)
        pb_field = "pushups" if exercise_type == "pushup" else "situps"
        label = "Push Ups" if exercise_type == "pushup" else "Sit Ups"
        session_date = datetime.now().strftime("%Y-%m-%d")
        session_time = datetime.now().strftime("%H:%M:%S")

        session_id = max([s.get("id", 0) for s in db.get("workout_sessions", [])], default=0) + 1
        session_record = {
            "id": session_id,
            "nric": nric,
            "exercise": exercise_type,
            "exercise_label": label,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "duration_seconds": duration_seconds,
            "started_at": started_at or None,
            "ended_at": ended_at,
            "video_file": filename,
            "video_path": relative_video_path.replace("\\", "/"),
            "personal_best": int(best.get(pb_field) or 0),
            "date": session_date,
            "time": session_time,
            "source": "webcam_cv",
            "ai_recommendation": None
        }
        db.setdefault("workout_sessions", []).append(session_record)

        log_id = max([log.get("id", 0) for log in db.get("performance_log", [])], default=0) + 1
        db.setdefault("performance_log", []).append({
            "id": log_id,
            "nric": nric,
            "event": f"Webcam {label}",
            "name": f"Webcam {label}",
            "type": "ippt",
            "score": f"{valid_reps} reps",
            "time": f"{duration_seconds // 60}:{duration_seconds % 60:02d} min",
            "date": session_date,
            "notes": (
                f"Computer vision session. Valid: {valid_reps}, invalid: {invalid_reps}, "
                f"duration: {duration_seconds}s. Video: {filename}."
            ),
            "exercise": exercise_type,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "duration_seconds": duration_seconds,
            "video_path": session_record["video_path"],
            "session_id": session_id,
            "ai_recommendation": None
        })
        return jsonify({
            "success": True,
            "filename": filename,
            "path": save_path,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "session_id": session_id,
            "personal_best": int(best.get(pb_field) or 0)
        })


@app.route("/api/ai-recommendation", methods=["POST"])
@login_required
def api_ai_recommendation():
    metrics = request.get_json(silent=True)
    if not metrics:
        return jsonify({"success": False, "error": "No session metrics provided."}), 400

    user = current_user()
    nric = user.get("nric")
    metrics = dict(metrics)
    session_id = metrics.pop("session_id", None)
    if session_id is not None:
        try:
            session_id = int(session_id)
        except (TypeError, ValueError):
            session_id = None

    metrics["athlete_name"] = user.get("name") or "Athlete"
    metrics["rank"] = user.get("rank") or ""

    result = generate_exercise_recommendation(metrics)
    if result.get("success") and session_id:
        db = get_db()
        saved = save_ai_recommendation(db, session_id, nric, result)
        result["session_id"] = session_id
        result["saved_to_database"] = saved

    status = 200 if result.get("success") else 503
    return jsonify(result), status


@app.route("/strava-sync")
@login_required
def strava_sync():
    """Render Strava sync page with auth code and app URLs."""
    user = current_user()
    strava_client_id = os.environ.get("STRAVA_CLIENT_ID", "")
    # The OAuth redirect should return to the Strava sync page where we handle the code
    strava_redirect_uri = url_for("strava_sync", _external=True)
    
    return render_template(
        "stravasync.html",
        user=user,
        strava_client_id=strava_client_id,
        strava_redirect_uri=strava_redirect_uri
    )


@app.route("/api/strava-callback", methods=["POST"])
@login_required
def api_strava_callback():
    """Exchange auth code for access token and fetch recent runs."""
    import requests
    
    data = request.get_json() or {}
    auth_code = data.get("code", "").strip()
    
    if not auth_code:
        return jsonify({"success": False, "error": "No authorization code provided"}), 400
    
    strava_client_id = os.environ.get("STRAVA_CLIENT_ID", "")
    strava_client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "")
    
    if not strava_client_id or not strava_client_secret:
        return jsonify({"success": False, "error": "Strava credentials not configured"}), 500
    
    try:
        # Exchange code for token
        token_response = requests.post(
            "https://www.strava.com/api/v3/oauth/token",
            data={
                "client_id": strava_client_id,
                "client_secret": strava_client_secret,
                "code": auth_code,
                "grant_type": "authorization_code"
            },
            timeout=10
        )
        
        if token_response.status_code != 200:
            return jsonify({
                "success": False,
                "error": "Failed to authenticate with Strava"
            }), 400
        
        token_data = token_response.json()
        access_token = token_data.get("access_token", "")
        athlete_id = token_data.get("athlete", {}).get("id", "")
        
        if not access_token:
            return jsonify({
                "success": False,
                "error": "No access token in response"
            }), 400
        
        # Fetch recent runs
        runs_response = requests.get(
            "https://www.strava.com/api/v3/athlete/activities",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"per_page": 5, "page": 1},
            timeout=10
        )
        
        if runs_response.status_code != 200:
            return jsonify({
                "success": False,
                "error": "Failed to fetch Strava activities"
            }), 400
        
        activities = runs_response.json()
        run_activities = [
            {
                "name": act.get("name", "Run"),
                "distance": round(act.get("distance", 0) / 1000, 2),
                "moving_time": act.get("moving_time", 0),
                "elapsed_time": act.get("elapsed_time", 0),
                "date": act.get("start_date", "").split("T")[0],
                "type": act.get("type", "Run")
            }
            for act in activities
            if act.get("type") == "Run"
        ]
        
        # Store token in session for this user
        user = current_user()
        session[f"strava_token_{user.get('nric')}"] = access_token
        session[f"strava_athlete_id_{user.get('nric')}"] = athlete_id
        
        return jsonify({
            "success": True,
            "activities": run_activities,
            "message": f"Successfully synced {len(run_activities)} recent runs"
        }), 200
    
    except requests.RequestException as e:
        return jsonify({
            "success": False,
            "error": f"Request error: {str(e)}"
        }), 500
    except Exception as e:
        return jsonify({
            "success": False,
            "error": f"Error: {str(e)}"
        }), 500


if __name__ == "__main__":
    # Ensure userdata directories exist
    os.makedirs(os.path.join(BASE_DIR, 'userdata', 'pushup_videos'), exist_ok=True)
    os.makedirs(os.path.join(BASE_DIR, 'userdata', 'situp_videos'), exist_ok=True)
    
    app.run(host="0.0.0.0", debug=True, use_reloader=False)
