from functools import wraps
from flask import session, redirect, url_for
from db import get_db

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
