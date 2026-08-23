"""One-off migration apply: 0022_stock_stations_and_items.sql.

`supabase db push --db-url` re-attempts every migration in the folder
including already-applied ones and fails on the first one it hits (this
project isn't under the CLI-linked org, see SESSION_HANDOFF.md) -- the
established workaround is applying just the new file directly via psycopg2.
Disposable, not meant to be rerun once applied.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

import psycopg2

SUPABASE_URL = os.environ["SUPABASE_URL"]
DB_PASSWORD = os.environ["SUPABASE_DB_PASSWORD"]
PROJECT_REF = SUPABASE_URL.split("//")[1].split(".")[0]

MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent / "supabase" / "migrations" / "0022_stock_stations_and_items.sql"
)

conn = psycopg2.connect(
    host=f"db.{PROJECT_REF}.supabase.co",
    port=5432,
    dbname="postgres",
    user="postgres",
    password=DB_PASSWORD,
)
conn.autocommit = False
try:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    print("Applied 0022_stock_stations_and_items.sql successfully.")
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
