from .auth import register_auth_routes
from .dashboard import register_dashboard_routes
from .groups import register_group_routes
from .performance import register_performance_routes
from .settings import register_settings_routes
from .strava import register_strava_routes
from .webcam import register_webcam_routes


def register_routes(app):
    register_auth_routes(app)
    register_dashboard_routes(app)
    register_group_routes(app)
    register_performance_routes(app)
    register_webcam_routes(app)
    register_strava_routes(app)
    register_settings_routes(app)
