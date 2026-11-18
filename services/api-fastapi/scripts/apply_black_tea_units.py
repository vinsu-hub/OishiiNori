"""Black tea the way Sir Joe counts it (2026-11-19):

    Black tea
        Pack (10)      <- 1 pack = 10 sachets
        Sachet (pcs)   <- the ingredient's base unit
        Base (ml)      <- Milk tea base, the brewed batch, shown right under it

1. "Tea bag" (made by apply_prep_bases.py, counted per pack) becomes
   "Black tea", counted in sachets, with a "pack" size of 10. Milk tea base's
   batch recipe line goes from 1 pack to 10 sachets (still shown as 1 pack).
2. Station item "Black tea" (liter) is the brewed base: it gets linked to
   Milk tea base, so EOD Stock Count and Stock Alerts show one row.
3. Milk tea base is placed right after Black tea on the Drip Tea sheet, so
   EOD Stock Count shows it as Black tea's "Base".

Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_black_tea_units.py
    ... --apply
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

OLD, NEW = "Tea bag", "Black tea"
SACHETS_PER_PACK = 10
BASE = "Milk tea base"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase

    db = get_supabase()
    by_name = {i["name"]: i for i in db.table("ingredients").select(
        "id, name, base_unit, current_stock, station, sheet_section, sort_order").execute().data}
    tea = by_name.get(NEW) or by_name.get(OLD)
    base = by_name.get(BASE)
    if not tea or not base:
        print(f"!! need both '{OLD}'/'{NEW}' and '{BASE}'")
        return 1
    changes = 0

    print("Black tea, counted in sachets:")
    if tea["name"] != NEW or tea["base_unit"] != "sachet":
        print(f"  {tea['name']} ({tea['base_unit']}) -> {NEW} (sachet); stock {tea['current_stock']} x{SACHETS_PER_PACK if tea['base_unit'] == 'pack' else 1}")
        changes += 1
        if args.apply:
            stock = float(tea["current_stock"]) * (SACHETS_PER_PACK if tea["base_unit"] == "pack" else 1)
            db.table("ingredients").update({"name": NEW, "base_unit": "sachet", "current_stock": stock}).eq("id", tea["id"]).execute()
    units = db.table("item_units").select("id, name, base_qty").eq("ingredient_id", tea["id"]).execute().data
    if not any(u["name"].lower() == "pack" for u in units):
        print(f"  + size pack = {SACHETS_PER_PACK} sachet")
        changes += 1
        if args.apply:
            db.table("item_units").insert({"ingredient_id": tea["id"], "name": "pack", "base_qty": SACHETS_PER_PACK}).execute()
    line = db.table("prep_recipe_items").select("id, qty, unit").eq("base_ingredient_id", base["id"]).eq("ingredient_id", tea["id"]).execute().data
    if line and tea["base_unit"] == "pack":
        new_qty = float(line[0]["qty"]) * SACHETS_PER_PACK
        print(f"  {BASE} batch: {line[0]['qty']:g} pack -> {new_qty:g} sachet (shown as pack)")
        changes += 1
        if args.apply:
            db.table("prep_recipe_items").update({"qty": new_qty, "unit": "pack"}).eq("id", line[0]["id"]).execute()

    print("Station item 'Black tea' is the brewed base:")
    item = (db.table("stock_items").select("id, name, ingredient_id, current_stock").eq("station", "cafe_drinks").eq("name", "Black tea").execute().data or [None])[0]
    if item and item["ingredient_id"] != base["id"]:
        if item["ingredient_id"]:
            print(f"  !! already linked to another ingredient -- skipped")
        else:
            print(f"  link Black tea (station item) -> {BASE}")
            changes += 1
            if args.apply:
                db.table("stock_items").update({"ingredient_id": base["id"]}).eq("id", item["id"]).execute()

    print("Sheet position:")
    order = (tea.get("sort_order") or 0) + 1
    if (base.get("station"), base.get("sheet_section"), base.get("sort_order")) != (tea.get("station"), tea.get("sheet_section"), order):
        print(f"  {BASE} -> right after Black tea: {tea.get('station')} / {tea.get('sheet_section')} #{order}")
        changes += 1
        if args.apply:
            db.table("ingredients").update({"station": tea.get("station"), "sheet_section": tea.get("sheet_section"), "sort_order": order}).eq("id", base["id"]).execute()

    print(f"\n{changes} change(s){'' if args.apply else ' (dry run -- add --apply)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
