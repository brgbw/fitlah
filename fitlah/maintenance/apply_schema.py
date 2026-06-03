from fitlah.data_access.database import ensure_tables


def main():
    ensure_tables(force=True)
    print("FitLah database schema is ready.")


if __name__ == "__main__":
    main()
