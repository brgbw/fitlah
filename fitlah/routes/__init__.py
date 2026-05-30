from .auth_routes import register_auth_routes
from .dashboard_routes import register_dashboard_routes
from .group_routes import register_group_routes
from .performance_routes import register_performance_routes
from .strava_routes import register_strava_routes
from .webcam_routes import register_webcam_routes


def register_routes(app):
    register_auth_routes(app)
    register_dashboard_routes(app)
    register_group_routes(app)
    register_performance_routes(app)
    register_webcam_routes(app)
    register_strava_routes(app)

