from flask import render_template

from ..auth import current_user, login_required
from ..db import query_db


def register_dashboard_routes(app):
    @app.route("/")
    @login_required
    def dashboard():
        user = current_user()
        workouts = query_db("workout")
        recent_logs = sorted(
            query_db("performance_log", lambda x: x.get("nric") == user.get("nric")),
            key=lambda x: x["id"],
            reverse=True,
        )[:3]
        return render_template("dashboard.html", user=user, workouts=workouts, recent_logs=recent_logs)

    @app.route("/dashboard-graph")
    @login_required
    def dashboard_graph():
        return render_template("dashboardgraph.html")
