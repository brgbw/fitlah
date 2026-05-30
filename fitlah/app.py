import os

from dotenv import load_dotenv
from flask import Flask

from .auth import current_user
from .config import BASE_DIR
from .db import close_db, initialize_database
from .routes import register_routes
from .schema import (
    ensure_auth_tables,
    ensure_group_invite_schema,
    ensure_performance_log_schema,
    ensure_personal_best_data,
)

load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(
    __name__,
    static_folder=os.path.join(BASE_DIR, "static"),
    template_folder=os.path.join(BASE_DIR, "templates"),
)
app.secret_key = os.environ.get("FITLAH_SECRET_KEY", "fitlah-dev-secret-key")
_database_initialized = False


@app.teardown_appcontext
def teardown_db(exception):
    close_db(exception)


@app.context_processor
def inject_current_user():
    return {"current_user": current_user()}


def init_db():
    global _database_initialized
    initialize_database([
        ensure_auth_tables,
        ensure_group_invite_schema,
        ensure_personal_best_data,
        ensure_performance_log_schema,
    ])
    _database_initialized = True


@app.before_request
def ensure_database_ready():
    if not _database_initialized:
        init_db()


register_routes(app)


if __name__ == "__main__":
    os.makedirs(os.path.join(BASE_DIR, "userdata", "pushup_videos"), exist_ok=True)
    os.makedirs(os.path.join(BASE_DIR, "userdata", "situp_videos"), exist_ok=True)
    init_db()

    app.run(host="0.0.0.0", debug=True, use_reloader=False)
