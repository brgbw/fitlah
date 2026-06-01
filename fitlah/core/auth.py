from functools import wraps
from flask import g, session, redirect, url_for
from ..domain.user_profile import enrich_age_fields
from ..data_access.repositories import get_user

def current_user():
    if hasattr(g, "_current_user"):
        return g._current_user

    nric = session.get("user_nric")
    if not nric:
        g._current_user = None
        return None

    user = get_user(nric)
    if user:
        safe_user = dict(user)
        safe_user.pop("password_hash", None)
        g._current_user = enrich_age_fields(safe_user)
        return g._current_user
    g._current_user = None
    return None

def login_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped_view
