"""Mark stale kitchen tickets from earlier PH days as completed.

Orders from before today that were served but never bumped on the Kitchen
Display pile up as queued / preparing / ready and show as "delayed" forever.
This sets only their kitchen_status to completed. It never changes payment
status, transaction status, totals or stock, so unpaid deliveries stay on the
Deliveries page until their cash is recorded.

Skips voided orders and advance orders still scheduled for today or later.

Run:  .venv/bin/python scripts/clear_kitchen_backlog.py           # dry run
      .venv/bin/python scripts/clear_kitchen_backlog.py --apply
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
    db = get_supabase()
    today_start = ph_day_bounds_utc(today_ph())[0]
    rows = _page_rows(
        db.table("transactions")
        .select("id, order_number, opened_at, kitchen_status, order_type, payment_status, scheduled_for")
        .in_("kitchen_status", ["queued", "preparing", "ready"])
        .neq("status", "voided")
        .lt("opened_at", today_start)
        .order("opened_at")
        .order("id")
    )
    stale = [r for r in rows if not r.get("scheduled_for") or r["scheduled_for"] < today_start]
    print(f"Stale kitchen tickets before {today_start}: {len(stale)}")
    print("  by kitchen status:", dict(Counter(r["kitchen_status"] for r in stale)))
    print("  unpaid among them (payment left as is):", sum(1 for r in stale if r.get("payment_status") == "unpaid"))
    if not apply:
        print("Dry run -- pass --apply to mark them completed.")
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    ids = [r["id"] for r in stale]
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        (db.table("transactions")
         .update({"kitchen_status": "completed", "kitchen_status_updated_at": now_iso})
         .in_("id", ids[offset:offset + ID_BATCH_SIZE])
         .in_("kitchen_status", ["queued", "preparing", "ready"])
         .execute())
    print(f"Marked {len(ids)} tickets completed.")


if __name__ == "__main__":
    main()
