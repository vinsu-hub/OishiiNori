"""Mark stale kitchen tickets as completed, and optionally release tables.

Orders that were served but never bumped on the Kitchen Display pile up as
queued / preparing / ready and show as "delayed" forever. This sets only their
kitchen_status to completed. It never changes payment status, totals or
stock, so unpaid deliveries stay on the Deliveries page until their cash is
recorded.

By default only tickets from before today (PH) are touched. --through-now
also includes today's tickets opened up to the moment the script runs (use
it after service, once the owner confirms everything was served).

--release-tables also closes every open dine-in order opened before the
cutoff (status closed + closed_at, like the Floor Plan's Release table), so
earlier days' unreleased orders stop showing tables as occupied.

Skips voided orders and advance orders still scheduled for later.

Run:  .venv/bin/python scripts/clear_kitchen_backlog.py           # dry run
      .venv/bin/python scripts/clear_kitchen_backlog.py --apply
      .venv/bin/python scripts/clear_kitchen_backlog.py --through-now --release-tables --apply
"""
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

from app.deps import get_supabase  # noqa: E402
from app.ph_time import ph_day_bounds_utc, today_ph  # noqa: E402
from app.routers.sales_insights import ID_BATCH_SIZE, _page_rows  # noqa: E402


def main() -> None:
    apply = "--apply" in sys.argv
    release = "--release-tables" in sys.argv
    db = get_supabase()
    now_iso = datetime.now(timezone.utc).isoformat()
    cutoff = now_iso if "--through-now" in sys.argv else ph_day_bounds_utc(today_ph())[0]

    rows = _page_rows(
        db.table("transactions")
        .select("id, order_number, opened_at, kitchen_status, order_type, payment_status, scheduled_for")
        .in_("kitchen_status", ["queued", "preparing", "ready"])
        .neq("status", "voided")
        .lt("opened_at", cutoff)
        .order("opened_at")
        .order("id")
    )
    stale = [r for r in rows if not r.get("scheduled_for") or r["scheduled_for"] < cutoff]
    print(f"Stale kitchen tickets before {cutoff}: {len(stale)}")
    print("  by kitchen status:", dict(Counter(r["kitchen_status"] for r in stale)))
    unpaid = [r["order_number"] for r in stale if r.get("payment_status") == "unpaid"]
    print(f"  unpaid among them (payment left as is): {len(unpaid)} {unpaid}")

    open_tables = []
    if release:
        open_tables = _page_rows(
            db.table("transactions")
            .select("id, order_number, table_number")
            .eq("status", "open")
            .eq("order_type", "dine_in")
            .lt("opened_at", cutoff)
            .order("opened_at")
            .order("id")
        )
        print(f"Open dine-in orders to release: {len(open_tables)}")
        print("  by table:", dict(sorted(Counter(r["table_number"] for r in open_tables).items(), key=lambda kv: kv[0] or 0)))

    if not apply:
        print("Dry run -- pass --apply to write.")
        return

    ids = [r["id"] for r in stale]
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        (db.table("transactions")
         .update({"kitchen_status": "completed", "kitchen_status_updated_at": now_iso})
         .in_("id", ids[offset:offset + ID_BATCH_SIZE])
         .in_("kitchen_status", ["queued", "preparing", "ready"])
         .execute())
    print(f"Marked {len(ids)} tickets completed.")

    ids = [r["id"] for r in open_tables]
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        (db.table("transactions")
         .update({"status": "closed", "closed_at": now_iso})
         .in_("id", ids[offset:offset + ID_BATCH_SIZE])
         .eq("status", "open")
         .execute())
    if release:
        print(f"Released {len(ids)} dine-in orders.")


if __name__ == "__main__":
    main()
