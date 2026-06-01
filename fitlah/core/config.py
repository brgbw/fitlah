import os

PACKAGE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
BASE_DIR = os.path.abspath(os.path.dirname(PACKAGE_DIR))
SEEDDATA_DIR = os.path.join(BASE_DIR, "seeddata")
