try:
    import importlib

    importlib.import_module("fitlah.routes.strava")
    print('import ok')
except Exception:
    import traceback
    traceback.print_exc()
    print('import failed')
