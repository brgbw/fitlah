import os
import json
from flask import g

BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__))) if 'app.py' not in __file__ else os.path.abspath(os.path.dirname(__file__))
# Let's just hardcode BASE_DIR for the directory where app.py is, or use os.path.abspath(os.path.dirname(__file__)) since db.py will be in the same folder.
BASE_DIR = os.path.abspath(os.path.dirname(__file__))

SERVERDATA_DIR = os.path.join(BASE_DIR, "serverdata")

TABLE_NAMES = [
    "user", "group_invite", "fitness_group",
    "group_member", "performance_log", "auth_user",
    "personal_best",
]


def _table_path(table_name):
    """Return the file path for a given table."""
    return os.path.join(SERVERDATA_DIR, f"{table_name}.json")

def load_db():
    """Load all per-table JSON files into a single dict."""
    db = {}
    for table in TABLE_NAMES:
        path = _table_path(table)
        if os.path.exists(path):
            with open(path, 'r') as f:
                db[table] = json.load(f)
        else:
            db[table] = []
    return db if any(db[t] for t in TABLE_NAMES) else None

def save_db(data):
    """Save each table to its own JSON file."""
    os.makedirs(SERVERDATA_DIR, exist_ok=True)
    for table in TABLE_NAMES:
        rows = data.get(table, [])
        with open(_table_path(table), 'w') as f:
            json.dump(rows, f, indent=2)


def get_db():
    """Get database from Flask app context."""
    db = getattr(g, '_database', None)
    if db is None:
        db = load_db()
        g._database = db
    return db

def close_db(exception=None):
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
