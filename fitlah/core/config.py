import os
import secrets
from dataclasses import dataclass
from functools import lru_cache

PACKAGE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
BASE_DIR = os.path.abspath(os.path.dirname(PACKAGE_DIR))


def env_str(name, default=""):
    return (os.environ.get(name) or default).strip()


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class AppConfig:
    database_url: str
    secret_key: str
    field_encryption_key: str
    production: bool
    public_base_url: str
    allowed_origins: tuple
    cookie_secure: bool
    cookie_samesite: str
    max_upload_bytes: int
    db_disable_pool: bool
    auto_migrate: bool
    strava_redirect_uri: str
    allow_strava_settings_write: bool
    gemini_api_key: str
    gemini_model: str

    @property
    def missing_required(self):
        missing = []
        if not self.database_url:
            missing.append("DATABASE_URL")
        if self.production and not self.secret_key:
            missing.append("FITLAH_SECRET_KEY")
        return missing

    @property
    def missing_recommended(self):
        names = []
        if self.production and not self.public_base_url:
            names.append("FITLAH_PUBLIC_BASE_URL")
        if self.production and not self.allowed_origins:
            names.append("FITLAH_ALLOWED_ORIGINS")
        return names

    @property
    def runtime_secret_key(self):
        return self.secret_key or secrets.token_urlsafe(32)


@lru_cache(maxsize=1)
def get_config():
    production = env_bool("FITLAH_PRODUCTION") or env_str("VERCEL_ENV") == "production"
    return AppConfig(
        database_url=env_str("DATABASE_URL"),
        secret_key=env_str("FITLAH_SECRET_KEY"),
        field_encryption_key=env_str("FIELD_ENCRYPTION_KEY"),
        production=production,
        public_base_url=env_str("FITLAH_PUBLIC_BASE_URL").rstrip("/"),
        allowed_origins=tuple(
            item.strip().rstrip("/")
            for item in env_str("FITLAH_ALLOWED_ORIGINS").split(",")
            if item.strip()
        ),
        cookie_secure=env_bool("FITLAH_COOKIE_SECURE", production),
        cookie_samesite=env_str("FITLAH_COOKIE_SAMESITE", "Lax") or "Lax",
        max_upload_bytes=env_int("FITLAH_MAX_UPLOAD_BYTES", 300 * 1024 * 1024),
        db_disable_pool=env_bool("FITLAH_DB_DISABLE_POOL") or bool(env_str("VERCEL")),
        auto_migrate=env_bool("FITLAH_AUTO_MIGRATE", True),
        strava_redirect_uri=env_str("FITLAH_STRAVA_REDIRECT_URI").rstrip("/"),
        allow_strava_settings_write=env_bool("FITLAH_ALLOW_STRAVA_SETTINGS_WRITE", False),
        gemini_api_key=_first_present("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "AI_API_KEY"),
        gemini_model=env_str("GEMINI_MODEL", "gemini-2.5-flash") or "gemini-2.5-flash",
    )


def _first_present(*names):
    return next((env_str(name) for name in names if env_str(name)), "")
