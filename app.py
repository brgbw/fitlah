from functools import wraps

from flask import Flask, render_template, g, request, jsonify, redirect, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
import json
import os
from datetime import datetime

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
SERVERDATA_DIR = os.path.join(BASE_DIR, "serverdata")
DATABASE = os.path.join(SERVERDATA_DIR, "database.json")
LEGACY_DATABASE = os.path.join(BASE_DIR, "mock.json")

app = Flask(__name__, template_folder="templates")
app.secret_key = os.environ.get("FITLAH_SECRET_KEY", "fitlah-dev-secret-key")


def load_db():
    """Load JSON database from file."""
    if os.path.exists(DATABASE):
        with open(DATABASE, 'r') as f:
            return json.load(f)
    if os.path.exists(LEGACY_DATABASE):
        with open(LEGACY_DATABASE, 'r') as f:
            return json.load(f)
    return None


def save_db(data):
    """Save JSON database to file."""
    os.makedirs(SERVERDATA_DIR, exist_ok=True)
    with open(DATABASE, 'w') as f:
        json.dump(data, f, indent=2)


def get_db():
    """Get database from Flask app context."""
    db = getattr(g, '_database', None)
    if db is None:
        db = load_db()
        g._database = db
    return db


def init_db():
    """Initialize database with JSON data if it doesn't exist."""
    os.makedirs(SERVERDATA_DIR, exist_ok=True)
    if os.path.exists(DATABASE):
        db = load_db()
        ensure_auth_tables(db)
        ensure_group_invite_schema(db)
        ensure_personal_best_data(db)
        save_db(db)
        return

    if os.path.exists(LEGACY_DATABASE):
        db = load_db()
        ensure_auth_tables(db)
        ensure_group_invite_schema(db)
        ensure_personal_best_data(db)
        save_db(db)
        return
    
    db = {
        "user": [
            {
                "id": 1,
                "nric": "S3456789C",
                "name": "2Lt. Amir Rahman",
                "rank": "Lieutenant",
                "unit": "5th Guards",
                "last_login": "2026-05-22"
            }
        ],
        "workout": [
            {
                "id": 1,
                "name": "Push Ups",
                "category": "Strength",
                "difficulty": "Medium",
                "progress": "12 / 20",
                "target": "3 sets"
            },
            {
                "id": 2,
                "name": "Sit Ups",
                "category": "Core",
                "difficulty": "Easy",
                "progress": "18 / 30",
                "target": "3 sets"
            },
            {
                "id": 3,
                "name": "2.4km Run",
                "category": "Cardio",
                "difficulty": "Hard",
                "progress": "12:35",
                "target": "Finish in 14:00"
            },
            {
                "id": 4,
                "name": "Plank Hold",
                "category": "Stability",
                "difficulty": "Medium",
                "progress": "1:40",
                "target": "2:30 target"
            }
        ],
        "group_invite": [
            {
                "id": 1,
                "sender": "Cpl. Tan Wei",
                "group_name": "Alpha Platoon",
                "invited_on": "2026-05-21",
                "status": "Pending"
            },
            {
                "id": 2,
                "sender": "Sgt. Lim Jun",
                "group_name": "Bravo Squad",
                "invited_on": "2026-05-20",
                "status": "Accepted"
            },
            {
                "id": 3,
                "sender": "Lt. Ong Mei",
                "group_name": "Charlie Team",
                "invited_on": "2026-05-19",
                "status": "Pending"
            }
        ],
        "fitness_group": [
            {
                "id": 1,
                "name": "Alpha Platoon",
                "created_by": "2Lt. Amir Rahman",
                "created_date": "2026-05-15"
            }
        ],
        "group_member": [
            {
                "id": 1,
                "group_id": 1,
                "nric": "S1234567A",
                "name": "Cpl. Tan Wei",
                "rank": "Corporal",
                "pushups": 55,
                "situps": 50,
                "run_time": "11:45"
            },
            {
                "id": 2,
                "group_id": 1,
                "nric": "S2345678B",
                "name": "Pte. Lim Jun",
                "rank": "Private",
                "pushups": 42,
                "situps": 38,
                "run_time": "13:20"
            },
            {
                "id": 3,
                "group_id": 1,
                "nric": "S3456789C",
                "name": "2Lt. Amir Rahman",
                "rank": "Lieutenant",
                "pushups": 60,
                "situps": 58,
                "run_time": "10:15"
            },
            {
                "id": 4,
                "group_id": 1,
                "nric": "S4567890D",
                "name": "Sgt. Chen Wei",
                "rank": "Sergeant",
                "pushups": 50,
                "situps": 48,
                "run_time": "12:30"
            }
        ],
        "performance_log": [
            {
                "id": 1,
                "event": "IPPT Sit Ups",
                "score": "18 reps",
                "date": "2026-05-11",
                "notes": "Good form, target 20 next week."
            },
            {
                "id": 2,
                "event": "Push Ups",
                "score": "12 reps",
                "date": "2026-05-11",
                "notes": "Build endurance for the next set."
            },
            {
                "id": 3,
                "event": "2.4km Run",
                "score": "12:35",
                "date": "2026-05-11",
                "notes": "Steady pace, maintain hydration."
            },
            {
                "id": 4,
                "event": "Fitness Assessment",
                "score": "79 / 100",
                "date": "2026-05-11",
                "notes": "Strong recovery after previous cycle."
            }
        ]
    }
    
    ensure_auth_tables(db)
    ensure_group_invite_schema(db)
    ensure_personal_best_data(db)
    save_db(db)


def ensure_auth_tables(db):
    """Ensure every known person has a login record stored in serverdata."""
    db.setdefault("auth_user", [])
    db.setdefault("user", [])

    existing = {u.get("nric", "").upper() for u in db["auth_user"]}
    people = []

    for profile in db["user"]:
        if profile.get("nric"):
            people.append(profile)

    for member in db.get("group_member", []):
        people.append({
            "nric": member.get("nric"),
            "name": member.get("name"),
            "rank": member.get("rank"),
            "unit": "5th Guards"
        })

    for person in people:
        nric = (person.get("nric") or "").strip().upper()
        if not nric or nric in existing:
            continue

        db["auth_user"].append({
            "id": len(db["auth_user"]) + 1,
            "nric": nric,
            "password_hash": generate_password_hash("password123"),
            "password_is_default": True,
            "name": person.get("name") or "NSman",
            "rank": person.get("rank") or "Soldier",
            "unit": person.get("unit") or "Unassigned",
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "last_login": None
        })
        existing.add(nric)


def ensure_group_invite_schema(db):
    """Keep invites addressable by sender, recipient, and group."""
    db.setdefault("group_invite", [])
    db.setdefault("fitness_group", [])

    default_group = db["fitness_group"][0] if db["fitness_group"] else {}
    current_profile = db.get("user", [{}])[0] if db.get("user") else {}
    default_recipient = (current_profile.get("nric") or "S3456789C").upper()

    for invite in db["group_invite"]:
        group_name = invite.get("group_name") or default_group.get("name") or "Training Group"
        matching_group = next((g for g in db["fitness_group"] if g.get("name") == group_name), default_group)
        invite.setdefault("group_id", matching_group.get("id", 1))
        invite.setdefault("group_name", group_name)
        invite.setdefault("sender_nric", "S1234567A")
        invite.setdefault("recipient_nric", default_recipient)
        invite.setdefault("invited_on", datetime.now().strftime("%Y-%m-%d"))
        invite.setdefault("status", "Pending")


def ensure_personal_best_data(db):
    """Store personal bests once per NRIC for display across joined groups."""
    db.setdefault("personal_best", [])
    existing = {pb.get("nric") for pb in db["personal_best"]}

    for member in db.get("group_member", []):
        nric = member.get("nric")
        if not nric or nric in existing:
            continue
        db["personal_best"].append({
            "nric": nric,
            "pushups": member.get("pushups", 0),
            "situps": member.get("situps", 0),
            "run_time": member.get("run_time", "--:--"),
            "updated_at": datetime.now().strftime("%Y-%m-%d")
        })
        existing.add(nric)

    mock_bests = {
        "T1234567A": {"pushups": 48, "situps": 52, "run_time": "12:18"},
        "T0725746A": {"pushups": 62, "situps": 59, "run_time": "10:58"}
    }
    for nric, best in mock_bests.items():
        row = next((pb for pb in db["personal_best"] if pb.get("nric") == nric), None)
        if row:
            row.update(best)
            row["updated_at"] = datetime.now().strftime("%Y-%m-%d")
        else:
            db["personal_best"].append({
                "nric": nric,
                **best,
                "updated_at": datetime.now().strftime("%Y-%m-%d")
            })


def current_user():
    nric = session.get("user_nric")
    if not nric:
        return None

    db = get_db()
    for user in db.get("auth_user", []):
        if user.get("nric") == nric:
            return user
    return None


def login_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped_view


@app.context_processor
def inject_current_user():
    return {"current_user": current_user()}


@app.teardown_appcontext
def close_db(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        save_db(db)


def query_db(table, where=None):
    """Query JSON database table with optional filtering."""
    db = get_db()
    if table not in db:
        return []
    
    rows = db[table]
    if where:
        rows = [r for r in rows if where(r)]
    
    return rows


def find_auth_user(nric):
    normalized = (nric or "").strip().upper()
    db = get_db()
    return next((u for u in db.get("auth_user", []) if u.get("nric") == normalized), None)


def find_group(group_id):
    db = get_db()
    return next((g for g in db.get("fitness_group", []) if g.get("id") == group_id), None)


def user_is_group_member(group_id, nric):
    normalized = (nric or "").strip().upper()
    db = get_db()
    return any(
        m.get("group_id") == group_id and m.get("nric") == normalized
        for m in db.get("group_member", [])
    )


def get_personal_best(nric):
    normalized = (nric or "").strip().upper()
    db = get_db()
    best = next((pb for pb in db.get("personal_best", []) if pb.get("nric") == normalized), None)
    if best:
        return best
    return {
        "nric": normalized,
        "pushups": 0,
        "situps": 0,
        "run_time": "--:--",
        "updated_at": None
    }


def member_with_personal_best(member):
    best = get_personal_best(member.get("nric"))
    return {
        **member,
        "personal_best": best,
        "pushups": best.get("pushups", 0),
        "situps": best.get("situps", 0),
        "run_time": best.get("run_time", "--:--")
    }


def create_invites_for_group(db, group, invited_nrics):
    created = 0
    sender = current_user()
    db.setdefault("group_invite", [])
    db.setdefault("group_member", [])

    for raw_nric in invited_nrics:
        recipient_nric = (raw_nric or "").strip().upper()
        if not recipient_nric or recipient_nric == sender.get("nric"):
            continue

        recipient = next((u for u in db.get("auth_user", []) if u.get("nric") == recipient_nric), None)
        already_invited = any(
            invite.get("group_id") == group.get("id")
            and invite.get("recipient_nric") == recipient_nric
            and invite.get("status") == "Pending"
            for invite in db["group_invite"]
        )

        if not recipient or already_invited or user_is_group_member(group.get("id"), recipient_nric):
            continue

        db["group_invite"].append({
            "id": max([i.get("id", 0) for i in db["group_invite"]], default=0) + 1,
            "sender": sender.get("name", "NSman"),
            "sender_nric": sender.get("nric"),
            "recipient_nric": recipient_nric,
            "recipient_name": recipient.get("name", "NSman"),
            "group_id": group.get("id"),
            "group_name": group.get("name"),
            "invited_on": datetime.now().strftime("%Y-%m-%d"),
            "status": "Pending"
        })
        created += 1

    return created


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
    recent_logs = sorted(query_db("performance_log"), key=lambda x: x['id'], reverse=True)[:3]
    return render_template("dashboard.html", user=user, workouts=workouts, recent_logs=recent_logs)


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
    logs = sorted(query_db("performance_log"), key=lambda x: x['id'], reverse=True)
    return render_template("performance_log.html", logs=logs)


@app.route("/webcam")
@login_required
def webcam():
    logs = sorted(query_db("webcam"), key=lambda x: x['id'], reverse=True)
    return render_template("webcam.html")



@app.route("/situps")
@login_required
def situps():
    exercise = {
        "title": "Sit Ups",
        "description": "Strengthen your core by performing sit ups with proper alignment and a controlled pace.",
        "reps": "3 sets of 18",
        "tips": "Focus on using your abdominal muscles rather than pulling on your neck. Keep your feet anchored."
    }
    return render_template("situps.html", exercise=exercise)


@app.route("/api/upload-video", methods=['POST'])
@login_required
def upload_video():
    if 'video' not in request.files:
        return jsonify({"success": False, "error": "No video file provided"}), 400
    
    file = request.files['video']
    exercise_type = request.form.get('exercise', 'pushup')
    
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400
        
    if file:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{exercise_type}_{timestamp}.webm"
        
        folder = "pushup_videos" if exercise_type == 'pushup' else "situp_videos"
        save_path = os.path.join(BASE_DIR, 'userdata', folder, filename)
        
        file.save(save_path)
        return jsonify({"success": True, "filename": filename, "path": save_path})


if __name__ == "__main__":
    # Ensure userdata directories exist
    os.makedirs(os.path.join(BASE_DIR, 'userdata', 'pushup_videos'), exist_ok=True)
    os.makedirs(os.path.join(BASE_DIR, 'userdata', 'situp_videos'), exist_ok=True)
    
    app.run(host="0.0.0.0", debug=True, use_reloader=False)
