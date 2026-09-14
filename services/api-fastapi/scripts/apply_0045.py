"""One-off migration apply: 0045_reservation_ticket_workflow.sql. See
apply_0022.py's docstring for why this is applied directly rather than via
`supabase db push`."""

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
    / "0045_reservation_ticket_workflow.sql"
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
            "and column_name in ('placed_at', 'placed_by', 'arrived_at', "
            "'has_advance_order', 'advance_order_fired_at') order by column_name"
        )
        res_cols = [r[0] for r in cur.fetchall()]
        cur.execute(
            "select table_name from information_schema.tables "
            "where table_schema = 'public' and table_name in "
            "('reservation_items', 'reservation_item_addons')"
        )
        new_tables = [r[0] for r in cur.fetchall()]
        cur.execute(
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = 'transactions' "
            "and column_name = 'related_transaction_id'"
        )
        txn_cols = [r[0] for r in cur.fetchall()]
    conn.commit()
    print("Applied 0045_reservation_ticket_workflow.sql successfully.")
    print(f"reservations new columns present: {res_cols}")
    print(f"new tables present: {new_tables}")
    print(f"transactions new columns present: {txn_cols}")
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
