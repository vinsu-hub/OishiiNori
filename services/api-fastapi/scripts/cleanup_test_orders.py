"""One-off maintenance: wipe every operational row from production so the
restaurant opens with clean boards.

Everything currently in transactions / digital_orders / reservations (and their
line items, overrides, sale-consumption stock movements, plus the test loss
records, the Oishii AI query log, and the physical-count entry) is QA/test data
left by the verify scripts and health checks -- local dev and prod share one
Supabase project (see the shared-Supabase note), so every verify run against a
local uvicorn also wrote here.

Deliberately does NOT touch: ingredients / stock_items / products / profiles /
business_settings / discount_types / tables / attendance / payroll / HR. The
~5 un-voided test sales left ingredient stock slightly below the last physical
count -- a fresh count on opening day covers it (accepted).

Idempotent -- a re-run deletes nothing. One transaction, rolls back on any error.

Run:  py -3 services/api-fastapi/scripts/cleanup_test_orders.py
Run this BEFORE apply_0033.py so the order-number backfill starts from empty.
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

# (label, SQL) -- order matters for the FKs:
#  - reservation_overrides.reservation_id is ON DELETE RESTRICT -> before reservations
#  - transaction_items / digital_order_* / transaction_item_addons / bundle_fulfillments
#    all cascade from their parent, so deleting the parent is enough
#  - digital_orders.transaction_id / reservation_overrides.transaction_id are
#    ON DELETE SET NULL, so transactions can go before digital_orders
STEPS = [
    ("reservation_overrides", "delete from reservation_overrides"),
    ("transactions", "delete from transactions"),
    ("digital_orders", "delete from digital_orders"),
    ("reservations", "delete from reservations"),
    (
        "inventory_movements (sale_consumption*)",
        "delete from inventory_movements "
        "where type in ('sale_consumption', 'sale_consumption_reversal')",
    ),
    ("loss_records", "delete from loss_records"),
    ("ai_query_log", "delete from ai_query_log"),
    ("stock_count_entries", "delete from stock_count_entries"),
]

conn = psycopg2.connect(
    host=f"db.{PROJECT_REF}.supabase.co",
    port=5432,
    dbname="postgres",
    user="postgres",
    password=DB_PASSWORD,
)
conn.autocommit = False
try:
    with conn.cursor() as cur:
        results = []
        for label, sql in STEPS:
            cur.execute(sql)
            results.append((label, cur.rowcount))
    conn.commit()
    total = sum(n for _, n in results)
    print(f"Deleted {total} row(s):")
    for label, n in results:
        print(f"  {label}: {n}")
    if total == 0:
        print("(nothing to clean up -- already empty)")
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
