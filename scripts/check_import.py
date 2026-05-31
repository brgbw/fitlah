import sys
sys.path.insert(0, '.')
try:
    from fitlah.routes import strava_routes
    print('import ok')
except Exception:
    import traceback
    traceback.print_exc()
    print('import failed')
