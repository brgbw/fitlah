from flask import jsonify, render_template, request

from ..auth import current_user, login_required
from ..helpers import get_personal_best
from ..ippt_scoring import AGE_GROUPS, DEFAULT_AGE_GROUP, calculate_from_personal_best
from ..repositories import activity_records as activity_records_for_nric, list_workouts
from ..session_cleanup import clear_session_analysis_files
from .strava_routes import strava_connection_context


def register_dashboard_routes(app):
    @app.route("/dashboard")
    @app.route("/")
    @login_required
    def dashboard():
        if request.args.get("cleanup_session_analysis") == "1":
            clear_session_analysis_files()
        user = current_user()
        selected_age_group = request.args.get("age_group") or user.get("age_group") or DEFAULT_AGE_GROUP
        personal_best = get_personal_best(user.get("nric"))
        ippt_score = calculate_from_personal_best(personal_best, selected_age_group)
        workouts = list_workouts()
        recent_logs = sorted(
            activity_records_for_nric(user.get("nric")),
            key=lambda x: x["id"],
            reverse=True,
        )[:3]
        return render_template(
            "dashboard.html",
            user=user,
            workouts=workouts,
            recent_logs=recent_logs,
            personal_best=personal_best,
            ippt_score=ippt_score,
            age_groups=AGE_GROUPS,
            **strava_connection_context(),
        )

    @app.route("/api/ippt-score")
    @login_required
    def api_ippt_score():
        user = current_user()
        age_group = request.args.get("age_group") or user.get("age_group") or DEFAULT_AGE_GROUP
        personal_best = get_personal_best(user.get("nric"))
        return jsonify({
            "success": True,
            "personal_best": personal_best,
            "score": calculate_from_personal_best(personal_best, age_group),
            "age_groups": AGE_GROUPS,
        })

    @app.route("/dashboard-graph")
    @login_required
    def dashboard_graph():
        return render_template("dashboardgraph.html")
