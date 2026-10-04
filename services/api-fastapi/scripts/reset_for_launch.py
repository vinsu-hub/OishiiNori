"""
Pre-launch reset: wipe demo/test operational history so the restaurant
starts on a clean system, keeping everything that is configuration.

CLEARS (rows deleted):
  orders      refunds, digital_orders (+ items/addons/QR deliveries cascade),
              transactions (+ items/addons/bundle fulfillments/POS deliveries
              cascade), transaction_daily_counters (order numbers restart),
              business_days
  reservations  reservation_overrides, reservations (+ items/addons cascade)
  stock       inventory_movements, stock_count_entries; ingredients and
              stock_items current_stock set to 0
  hr          hr.payroll_records (+ payroll_items cascade),
              hr.attendance_logs (+ payroll_overrides cascade), hr.payroll_audit_log
  misc        utility_logs, idempotency_keys, rate_limit_counters,
              kitchen_printer_status heartbeat fields reset

KEEPS: products/sizes/recipes/add-ons/bundles, ingredients and stock_items
themselves (names, units, thresholds, costs), tables + floor plan, profiles
and staff accounts, settings, discounts, payment methods, delivery fees,
holidays and pay rules, kiosks, reviews/inquiries/applicants.

Every affected table is first exported to --backup (JSON). It holds customer
names/phones from test orders: keep it private and outside the repo.

Run with:  .venv/bin/python scripts/reset_for_launch.py                         # dry run (counts only)
           .venv/bin/python scripts/reset_for_launch.py --apply --backup /path/backup.json
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

URL = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SECRET_KEY"]

# (schema, table, filter column that's never null). Order matters: children
# with ON DELETE RESTRICT first (refunds -> transactions, reservation_overrides
# -> reservations); cascading children are listed only so they're backed up
# and counted.
DELETE_ORDER = [
    ("public", "refunds", "id"),
    ("public", "reservation_overrides", "id"),
    ("public", "reservation_item_addons", "id"),
    ("public", "reservation_items", "id"),
    ("public", "reservations", "id"),
    ("public", "deliveries", "id"),
    ("public", "digital_order_addons", "id"),
    ("public", "digital_order_items", "id"),
    ("public", "digital_orders", "id"),
    ("public", "bundle_fulfillments", "id"),
    ("public", "transaction_item_addons", "id"),
    ("public", "transaction_items", "id"),
    ("public", "transactions", "id"),
    ("public", "transaction_daily_counters", "business_date"),
    ("public", "business_days", "id"),
    ("public", "inventory_movements", "id"),
    ("public", "stock_count_entries", "id"),
    ("public", "utility_logs", "id"),
    ("public", "idempotency_keys", "key"),
    ("public", "rate_limit_counters", "bucket_key"),
    ("hr", "payroll_items", "id"),
    ("hr", "payroll_records", "id"),
    ("hr", "payroll_overrides", "id"),
    ("hr", "attendance_logs", "id"),
    ("hr", "payroll_audit_log", "id"),
]
ZERO_STOCK = ["ingredients", "stock_items"]
# Tables backed up but not deleted (stock is zeroed; printer status reset).
BACKUP_ONLY = [("public", "ingredients"), ("public", "stock_items"), ("public", "kitchen_printer_status")]


def headers(schema: str, **extra) -> dict:
    return {
        "apikey": KEY,
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "Accept-Profile": schema,
        "Content-Profile": schema,
        **extra,
    }


def count(schema: str, table: str) -> int:
    r = requests.head(f"{URL}/{table}?select=*", headers=headers(schema, Prefer="count=exact"), timeout=30)
    r.raise_for_status()
    return int(r.headers["content-range"].split("/")[-1])


def fetch_all(schema: str, table: str) -> list[dict]:
    rows, start, page = [], 0, 1000
    while True:
        r = requests.get(
            f"{URL}/{table}?select=*", headers=headers(schema, Range=f"{start}-{start + page - 1}"), timeout=60
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < page:
            return rows
        start += page


def main() -> None:
    apply = "--apply" in sys.argv
    backup = Path(sys.argv[sys.argv.index("--backup") + 1]) if "--backup" in sys.argv else None
    if apply and backup is None:
        sys.exit("--apply needs --backup <path.json> (keep it outside the repo).")

    print(f"{'APPLY' if apply else 'DRY RUN'} -- pre-launch reset\n")
    for schema, table, _ in DELETE_ORDER:
        print(f"  delete  {schema}.{table:28} {count(schema, table):>6} rows")
    for table in ZERO_STOCK:
        rows = fetch_all("public", table)
        nonzero = sum(1 for r in rows if (r.get("current_stock") or 0) != 0)
        print(f"  zero    public.{table:28} {nonzero:>6} of {len(rows)} with stock")
    print("  reset   public.kitchen_printer_status       heartbeat/print/error fields")

    if not apply:
        print("\nDry run only -- nothing changed.")
        return

    snapshot = {"taken_at": datetime.now(timezone.utc).isoformat(), "tables": {}}
    for schema, table, _ in DELETE_ORDER:
        snapshot["tables"][f"{schema}.{table}"] = fetch_all(schema, table)
    for schema, table in BACKUP_ONLY:
        snapshot["tables"][f"{schema}.{table}"] = fetch_all(schema, table)
    backup.write_text(json.dumps(snapshot, indent=1, default=str), encoding="utf-8")
    total = sum(len(v) for v in snapshot["tables"].values())
    print(f"\nBackup written: {backup} ({total} rows)")

    for schema, table, col in DELETE_ORDER:
        r = requests.delete(f"{URL}/{table}?{col}=not.is.null", headers=headers(schema), timeout=120)
        if not r.ok:
            sys.exit(f"FAILED deleting {schema}.{table}: {r.status_code} {r.text[:300]} -- stopped; backup is at {backup}")
    for table in ZERO_STOCK:
        r = requests.patch(
            f"{URL}/{table}?id=not.is.null", headers=headers("public"), json={"current_stock": 0}, timeout=120
        )
        r.raise_for_status()
    requests.patch(
        f"{URL}/kitchen_printer_status?id=eq.1",
        headers=headers("public"),
        json={
            "last_heartbeat_at": None,
            "last_print_at": None,
            "last_print_order_number": None,
            "last_error": None,
            "last_error_at": None,
        },
        timeout=30,
    ).raise_for_status()

    print("\nAfter reset:")
    for schema, table, _ in DELETE_ORDER:
        n = count(schema, table)
        if n:
            print(f"  ! {schema}.{table} still has {n} rows")
    for table in ZERO_STOCK:
        left = sum(1 for r in fetch_all("public", table) if (r.get("current_stock") or 0) != 0)
        print(f"  {table}: {left} rows with non-zero stock")
    print("Done.")


if __name__ == "__main__":
    main()
