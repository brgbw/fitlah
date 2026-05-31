import os

from dotenv import load_dotenv
from flask import Flask, url_for

from .auth import current_user
from .config import BASE_DIR
from .db import close_db, ensure_tables
from .routes import register_routes

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
    return {
        "current_user": current_user(),
        "asset_url": asset_url,
    }


def asset_url(filename):
    path = os.path.join(BASE_DIR, "static", filename)
    version = int(os.path.getmtime(path)) if os.path.exists(path) else 1
    return url_for("static", filename=filename, v=version)


app.jinja_env.globals["asset_url"] = asset_url


def init_db():
    global _database_initialized
    ensure_tables()
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
