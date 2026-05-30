# Local PostgreSQL Setup

1. Install and start PostgreSQL locally.
2. Create the application database:

```sql
CREATE DATABASE fitlah;
```

3. Set the connection string in `.env`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fitlah
```

4. Install Python dependencies:

```powershell
pip install -r requirements.txt
```

5. Start the app:

```powershell
python app.py
```

On first startup, the app creates the required PostgreSQL tables. If the tables are empty, it imports the existing files in `serverdata/` once as seed data.



CODE TO COPY PASTE (For Branden USE)

postgresql installed under local program files

PS C:\Windows\System32> cd "C:\Program Files\PostgreSQL"
PS C:\Program Files\PostgreSQL> cd "C:\Program Files\PostgreSQL\18\bin" >> .\psql.exe -U postgres
Password = "newpassword" (password for database)
\c fitlah (goes to fitlah app database structure)
SELECT * FROM auth_user; (GOES TO THE PARTICULAR DATABASE)