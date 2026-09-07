"""One-off migration apply: 0034_reservation_seating.sql. See apply_0022.py's
docstring for why this is applied directly rather than via `supabase db push`."""

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
    Path(__file__).resolve().parent.parent.parent.parent
    / "supabase"
    / "migrations"
    / "0034_reservation_seating.sql"
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
        cur.execute(
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = 'reservations' "
            "and column_name in ('seated_at', 'transaction_id') order by column_name"
        )
        cols = [r[0] for r in cur.fetchall()]
    conn.commit()
    print("Applied 0034_reservation_seating.sql successfully.")
    print(f"reservations new columns present: {cols}")
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
