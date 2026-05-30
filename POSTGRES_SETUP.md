# Local PostgreSQL Setup

Use this guide to install PostgreSQL, create the local `fitlah` database, and start the app against it.

## 1. Download PostgreSQL

1. Go to the official PostgreSQL downloads page: https://www.postgresql.org/download/
2. Choose your operating system.
3. For Windows, download the interactive installer from EnterpriseDB.
4. Run the installer and keep the default components selected, including:
   - PostgreSQL Server
   - pgAdmin 4
   - Command Line Tools
5. When the installer asks for the `postgres` user password, set a password you can remember.
6. Keep the default port as `5432` unless you already have another PostgreSQL server using that port.

## 2. Start PostgreSQL

On Windows, PostgreSQL usually starts automatically after installation.

To check or start it manually:

1. Open the Start menu.
2. Search for `Services`.
3. Find a service named like `postgresql-x64-18` or `postgresql-x64-17`.
4. Right-click it and choose `Start` or `Restart`.

You can also start it from PowerShell if your service name is different:

```powershell
Get-Service *postgres*
Start-Service postgresql-x64-18
```

## 3. Create the Fitlah database

Open PowerShell and go to the PostgreSQL `bin` folder. Change `18` if you installed a different version.

```powershell
cd "C:\Program Files\PostgreSQL\18\bin"
.\psql.exe -U postgres
```

Enter the password you created during installation, then run:

```sql
CREATE DATABASE fitlah;
\c fitlah
```

You can confirm the connection with:

```sql
SELECT current_database();
```

Exit `psql` with:

```sql
\q
```

## 4. Configure the app

Create or update `.env` in the project root:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/fitlah
```

Replace `your_password` with your local `postgres` password.

## 5. Install Python dependencies

From the project root:

```powershell
pip install -r requirements.txt
```

## 6. Start the app

```powershell
python app.py
```

On first startup, the app creates the required PostgreSQL tables. If the tables are empty, it imports the JSON files in `seeddata/` once as seed data.

## Useful psql commands

```sql
\l
\c fitlah
\dt
SELECT * FROM auth_user;
SELECT * FROM user;
\q
```
