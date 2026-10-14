"""List a day's unpaid delivery orders on the Hanged Orders tab.

Delivery sales rung up as pay-on-delivery whose cash was never recorded have
no place to take payment once their kitchen tickets are bumped. This links
each one to a `submitted` pos_hanged_orders row (payload rebuilt from the
sale's own items and delivery details), so it shows under "Sent to kitchen --
waiting for completion" where staff record how it was paid.

Skips voided sales and sales already linked to a hanged order. Never changes
the sale itself.

Run:  .venv/bin/python scripts/move_unpaid_deliveries_to_hanged.py              # today, dry run
      .venv/bin/python scripts/move_unpaid_deliveries_to_hanged.py --apply
      .venv/bin/python scripts/move_unpaid_deliveries_to_hanged.py 2026-10-14 --apply
"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

from app.deps import get_supabase  # noqa: E402
from app.ph_time import ph_day_bounds_utc, today_ph  # noqa: E402

DELIVERY_FIELDS = ("customer_name", "customer_phone", "address", "landmark", "barangay")


def main() -> None:
    apply = "--apply" in sys.argv
    days = [a for a in sys.argv[1:] if not a.startswith("--")]
    day = date.fromisoformat(days[0]) if days else today_ph()
    start, end = ph_day_bounds_utc(day)
    db = get_supabase()

    sales = (db.table("transactions").select("*")
             .eq("order_type", "delivery").eq("payment_status", "unpaid").neq("status", "voided")
             .gte("opened_at", start).lte("opened_at", end).order("opened_at").execute().data or [])
    ids = [s["id"] for s in sales]
    linked = {r["transaction_id"] for r in (db.table("pos_hanged_orders").select("transaction_id")
                                            .in_("transaction_id", ids).execute().data or [])} if ids else set()
    sales = [s for s in sales if s["id"] not in linked]
    print(f"Unpaid deliveries on {day} not yet on Hanged Orders: {len(sales)}")

    for sale in sales:
        items = db.table("transaction_items").select("*").eq("transaction_id", sale["id"]).execute().data or []
        delivery = (db.table("deliveries").select("*").eq("transaction_id", sale["id"]).execute().data or [None])[0]
        payload = {
            "employee_id": sale["employee_id"],
            "order_type": "delivery",
            "items": [{"product_size_id": i["product_size_id"], "quantity": int(i["quantity"]),
                       "addons": [], "held_ingredients": i.get("held_ingredients") or []} for i in items],
            "delivery": {k: (delivery or {}).get(k) for k in DELIVERY_FIELDS},
            "delivery_fee": (delivery or {}).get("delivery_fee") or 0,
            "force_vat_exempt": bool(sale.get("force_vat_exempt")),
        }
        name = payload["delivery"]["customer_name"] or "no delivery details"
        print(f"  #{sale['order_number']}  ₱{sale['total_amount']:,.2f}  {name}  ({len(items)} lines)")
        if apply:
            db.table("pos_hanged_orders").insert({
                "employee_id": sale["employee_id"], "payload": payload,
                "status": "submitted", "transaction_id": sale["id"],
            }).execute()

    print("Applied." if apply else "Dry run -- pass --apply to write.")


if __name__ == "__main__":
    main()
