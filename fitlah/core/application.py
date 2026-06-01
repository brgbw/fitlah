import os

from dotenv import load_dotenv
from flask import Flask, url_for

from .auth import current_user
from .config import BASE_DIR
from ..data_access.database import close_db, ensure_tables
from ..data_access.repositories import get_setting
from ..routes import register_routes
from .web_security import configure_security

load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(
    __name__,
    static_folder=os.path.join(BASE_DIR, "static"),
    template_folder=os.path.join(BASE_DIR, "templates"),
)
configure_security(app)
_database_initialized = False


@app.teardown_appcontext
def teardown_db(exception):
    close_db(exception)


@app.context_processor
def inject_current_user():
    return {
        "current_user": current_user(),
        "asset_url": asset_url,
        "font_scale": _font_scale(),
    }


def _font_scale():
    try:
        value = float(get_setting("font_scale", "1"))
    except (TypeError, ValueError, RuntimeError):
        value = 1.0
    return min(1.4, max(0.85, value))


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

    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    port = int(os.environ.get("FLASK_RUN_PORT", "5000"))
    app.run(host=os.environ.get("FLASK_RUN_HOST", "127.0.0.1"), port=port, debug=debug, use_reloader=False)
