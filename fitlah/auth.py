from functools import wraps
from flask import g, session, redirect, url_for
from .profile_age import enrich_age_fields
from .repositories import get_user

def current_user():
    if hasattr(g, "_current_user"):
        return g._current_user

    nric = session.get("user_nric")
    if not nric:
        g._current_user = None
        return None

    user = get_user(nric)
    if user:
        g._current_user = enrich_age_fields(user)
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
