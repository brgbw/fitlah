try:
    from fitlah.routes import strava
    print('import ok')
except Exception:
    import traceback
    traceback.print_exc()
    print('import failed')
