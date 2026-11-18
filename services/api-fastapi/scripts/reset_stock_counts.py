"""Reset every stock count to 0 so Sir Joe can do a fresh starting count.

Most ingredients sit on a 9,999,xxx placeholder from setup, so stock levels
and low-stock alerts mean nothing yet. This:

  * logs one count_adjustment per ingredient / unlinked station item that
    isn't already 0 ("Stock reset for fresh count: 9992588 -> 0"), so the
    history shows where the stock went;
  * sets ingredients.current_stock = 0 and last_counted_at = null (migration
    0086), and station items' current_stock = 0.

KEEPS all history (sales, deliveries, movements, count entries), thresholds,
costs, recipes.

Until an ingredient is counted again (EOD Stock Count), it shows "Not
counted yet": no low-stock alert, and it never marks a menu item out of
stock on the POS (app/stock_alerts.py) -- so the shop can keep selling while
the count is done. Run after closing. Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/reset_stock_counts.py
    ... --apply --backup ~/oishii-stock-before-reset.json
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", help="JSON file to save every stock level to first (required with --apply)")
    args = parser.parse_args()
    if args.apply and not args.backup:
        parser.error("--apply needs --backup <file.json>")

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase
    from app.routers.sales_insights import _page_rows
    from app.stock_alerts import counts_supported_check

    db = get_supabase()
    has_0086 = counts_supported_check(db)
    if args.apply and not has_0086:
        print("Run migration 0086 first: without last_counted_at, zeroed stock would mark every menu item out of stock on the POS.")
        return 1

    ing_cols = "id, name, base_unit, current_stock, reorder_threshold" + (", last_counted_at" if has_0086 else "")
    ingredients = _page_rows(db.table("ingredients").select(ing_cols).order("name"))
    items = _page_rows(db.table("stock_items").select("id, name, unit, station, ingredient_id, current_stock, reorder_threshold").order("name"))

    owner = (db.table("profiles").select("id, full_name").eq("role", "executive").order("created_at").limit(1).execute().data or [None])[0]
    if not owner:
        print("No executive profile to log the reset under.")
        return 1

    today = datetime.now(timezone.utc).date().isoformat()
    movements = []
    for i in ingredients:
        stock = float(i["current_stock"])
        if stock != 0:
            movements.append({"ingredient_id": i["id"], "type": "count_adjustment", "quantity": abs(stock),
                              "reason": f"Stock reset for fresh count ({today}): {stock:g} -> 0", "employee_id": owner["id"]})
    unlinked = [s for s in items if not s["ingredient_id"]]
    for s in unlinked:
        stock = float(s["current_stock"])
        if stock != 0:
            movements.append({"stock_item_id": s["id"], "type": "count_adjustment", "quantity": abs(stock),
                              "reason": f"Stock reset for fresh count ({today}): {stock:g} -> 0", "employee_id": owner["id"]})

    placeholders = sum(1 for i in ingredients if float(i["current_stock"]) >= 9_000_000)
    real = [i for i in ingredients if 0 < float(i["current_stock"]) < 9_000_000]
    print(f"Ingredients: {len(ingredients)} ({placeholders} on the 9,999,xxx placeholder, {len(real)} with a real count)")
    for i in real:
        print(f"  {i['name']}: {float(i['current_stock']):g} {i['base_unit']} -> 0")
    print(f"Station items: {len(items)} ({len(unlinked)} with their own stock, "
          f"{sum(1 for s in unlinked if float(s['current_stock']) != 0)} not at 0)")
    print(f"Movements to log: {len(movements)} count_adjustment, under {owner['full_name']}")
    if not args.apply:
        print("\nDry run -- add --apply --backup <file.json>")
        return 0

    with open(os.path.expanduser(args.backup), "w") as f:
        json.dump({"taken_at": datetime.now(timezone.utc).isoformat(), "ingredients": ingredients, "stock_items": items}, f, indent=1, default=str)
    print(f"Backup: {args.backup}")

    for start in range(0, len(movements), 200):
        db.table("inventory_movements").insert(movements[start:start + 200]).execute()
    db.table("ingredients").update({"current_stock": 0, "last_counted_at": None}).not_.is_("id", "null").execute()
    db.table("stock_items").update({"current_stock": 0}).not_.is_("id", "null").execute()

    left = [i for i in _page_rows(db.table("ingredients").select("id, current_stock").order("id")) if float(i["current_stock"]) != 0]
    print(f"Done. Ingredients not at 0 afterwards: {len(left)} (a sale during the reset would show here)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
