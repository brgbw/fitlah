import html
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from functools import wraps
from fnmatch import fnmatch
from urllib.parse import urlparse

from flask import jsonify, request, session


logger = logging.getLogger(__name__)
_RATE_LIMITS = defaultdict(deque)


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def app_secret_key():
    secret = (os.environ.get("FITLAH_SECRET_KEY") or "").strip()
    if secret:
        return secret
    if env_bool("FITLAH_PRODUCTION") or os.environ.get("FLASK_ENV") == "production":
        raise RuntimeError("FITLAH_SECRET_KEY must be set in production.")
    secret = secrets.token_urlsafe(32)
    os.environ["FITLAH_SECRET_KEY"] = secret
    return secret


def configure_security(app):
    app.secret_key = app_secret_key()
    app.config.update(
        MAX_CONTENT_LENGTH=int(os.environ.get("FITLAH_MAX_UPLOAD_BYTES", 300 * 1024 * 1024)),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE=os.environ.get("FITLAH_COOKIE_SAMESITE", "Lax"),
        SESSION_COOKIE_SECURE=env_bool("FITLAH_COOKIE_SECURE", env_bool("FITLAH_PRODUCTION")),
    )

    @app.before_request
    def enforce_allowed_origin():
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return None
        allowed = _allowed_origins()
        origin = request.headers.get("Origin")
        referer = request.headers.get("Referer")
        source = origin or _origin_from_url(referer)
        if source and not _origin_allowed(source, allowed):
            return jsonify({"success": False, "error": "Request origin is not allowed."}), 403
        return None

    @app.after_request
    def add_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        origin = request.headers.get("Origin")
        if origin and _origin_allowed(origin, _allowed_origins()):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE"
            response.headers["Access-Control-Allow-Headers"] = request.headers.get(
                "Access-Control-Request-Headers",
                "Content-Type, Authorization",
            )
        return response

    @app.errorhandler(413)
    def request_too_large(error):
        return jsonify({"success": False, "error": "Uploaded file is too large."}), 413

    @app.errorhandler(500)
    def internal_error(error):
        logger.exception("Unhandled application error")
        return jsonify({"success": False, "error": "An internal error occurred."}), 500


def _client_key(scope):
    user = session.get("user_nric") or "anonymous"
    remote = request.headers.get("X-Forwarded-For", request.remote_addr or "local").split(",")[0].strip()
    return f"{scope}:{user}:{remote}"


def _allowed_origins():
    configured = os.environ.get("FITLAH_ALLOWED_ORIGINS", "")
    return {item.strip().rstrip("/") for item in configured.split(",") if item.strip()}


def _origin_allowed(source, allowed):
    normalized = source.strip().rstrip("/")
    if not normalized:
        return False
    if normalized in allowed or _matches_allowed_pattern(normalized, allowed):
        return True
    return _is_same_request_origin(normalized)


def _matches_allowed_pattern(source, allowed):
    parsed = urlparse(source)
    if not parsed.scheme or not parsed.netloc:
        return False
    for pattern in allowed:
        if "*" not in pattern:
            continue
        candidate = pattern.strip().rstrip("/")
        if fnmatch(source, candidate):
            return True
        parsed_pattern = urlparse(candidate)
        if parsed_pattern.scheme and parsed_pattern.scheme != parsed.scheme:
            continue
        if parsed_pattern.netloc and fnmatch(parsed.netloc, parsed_pattern.netloc):
            return True
    return False


def _is_same_request_origin(source):
    parsed = urlparse(source)
    if not parsed.scheme or not parsed.netloc:
        return False

    forwarded_host = (request.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
    request_hosts = {request.host}
    if forwarded_host:
        request_hosts.add(forwarded_host)
    if parsed.netloc not in request_hosts:
        return False

    forwarded_proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
    request_schemes = {request.scheme}
    if forwarded_proto:
        request_schemes.add(forwarded_proto)
    return parsed.scheme in request_schemes


def _origin_from_url(value):
    if not value:
        return ""
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def rate_limit(scope, limit, window_seconds):
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            now = time.monotonic()
            key = _client_key(scope)
            bucket = _RATE_LIMITS[key]
            while bucket and now - bucket[0] > window_seconds:
                bucket.popleft()
            if len(bucket) >= limit:
                return jsonify({"success": False, "error": "Too many requests. Try again later."}), 429
            bucket.append(now)
            return view(*args, **kwargs)
        return wrapped
    return decorator


def clean_text(value, max_length=255):
    text = str(value or "").strip()
    text = " ".join(text.split())
    return html.escape(text[:max_length], quote=False)


def bounded_int(value, default=0, minimum=0, maximum=120):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def json_too_large(max_bytes):
    return bool(request.content_length and request.content_length > max_bytes)


def limit_structure(value, max_depth=4, max_items=80, max_text=500):
    if max_depth <= 0:
        return None
    if isinstance(value, dict):
        return {
            clean_text(key, 80): limit_structure(item, max_depth - 1, max_items, max_text)
            for key, item in list(value.items())[:max_items]
        }
    if isinstance(value, list):
        return [limit_structure(item, max_depth - 1, max_items, max_text) for item in value[:max_items]]
    if isinstance(value, str):
        return clean_text(value, max_text)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return clean_text(value, max_text)
