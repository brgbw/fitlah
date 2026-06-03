import os
import re

from flask import Flask, jsonify, request, url_for
from markupsafe import Markup, escape
from sqlalchemy import text

from .auth import current_user
from .config import BASE_DIR, get_config
from .responses import api_error
from ..data_access.database import close_db, ensure_tables, session_scope
from ..data_access.repositories import get_setting
from ..integrations.ai_coach import get_gemini_config
from ..routes import register_routes
from .web_security import configure_security

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
    except Exception:
        value = 1.0
    return min(1.4, max(0.85, value))


def asset_url(filename):
    path = os.path.join(BASE_DIR, "static", filename)
    version = int(os.path.getmtime(path)) if os.path.exists(path) else 1
    return url_for("static", filename=filename, v=version)


def ai_bold(text):
    value = str(text or "")
    parts = []
    cursor = 0
    for match in re.finditer(r"\*\*([^*]+?)\*\*", value):
        parts.append(escape(value[cursor:match.start()]))
        parts.append(Markup("<strong>") + escape(match.group(1).strip()) + Markup("</strong>"))
        cursor = match.end()
    parts.append(escape(value[cursor:]))
    return Markup("".join(str(part) for part in parts))


app.jinja_env.globals["asset_url"] = asset_url
app.jinja_env.filters["ai_bold"] = ai_bold


def init_db():
    global _database_initialized
    ensure_tables()
    _database_initialized = True


@app.route("/healthz")
def healthz():
    config = get_config()
    missing_required = config.missing_required
    missing_recommended = config.missing_recommended

    return jsonify({
        "success": not missing_required,
        "database": "configured" if config.database_url else "not_configured",
        "auto_migrate": config.auto_migrate,
        "environment": "production" if config.production else "development",
        "missing_required": missing_required,
        "missing_recommended": missing_recommended,
    }), 200 if not missing_required else 503


@app.route("/healthz/db")
def healthz_db():
    if not get_config().database_url:
        return jsonify({"success": False, "database": "not_configured"}), 503

    try:
        with session_scope() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:
        return jsonify({
            "success": False,
            "database": "connection_failed",
            "error_type": exc.__class__.__name__,
        }), 503

    return jsonify({"success": True, "database": "ok"}), 200


@app.route("/healthz/ai")
def healthz_ai():
    config = get_gemini_config()
    success = bool(config.get("api_key_present")) and bool(config.get("sdk_available"))
    return jsonify({
        "success": success,
        "provider": "gemini",
        "model": config.get("model"),
        "api_key_present": bool(config.get("api_key_present")),
        "sdk_available": bool(config.get("sdk_available")),
        "sdk_import_error": config.get("sdk_import_error", ""),
    }), 200 if success else 503


@app.before_request
def ensure_database_ready():
    if request.endpoint in {"healthz", "healthz_db", "healthz_ai", "static"}:
        return None
    config = get_config()
    if config.missing_required:
        return api_error(
            f"Missing required environment variables: {', '.join(config.missing_required)}.",
            503,
            code="configuration_error",
        )
    if not _database_initialized:
        init_db()
    return None


register_routes(app)
