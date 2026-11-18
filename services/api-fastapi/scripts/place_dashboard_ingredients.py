"""Put the ingredients Sir Joe added on the dashboard (2026-11-14 / 18) on the
EOD Stock Count sheet.

Most of them are the same thing as a Station Items row that already exists
(sodas, cups, lids, pans...). He made them ingredients so sales take them off
stock through recipes. Linking the ingredient to its station item
(stock_items.ingredient_id) makes them one row: the stock lives on the
ingredient, the station item stops being counted separately, and the
ingredient takes the station item's place on the sheet.

The rest have no station item and are just placed. PHOTO stays Unsorted for
Sir Joe to place on the EOD page. Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/place_dashboard_ingredients.py
    ... --apply
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

R, M, D = "ramen_hot_line", "sushi_kitchen_main", "cafe_drinks"

# ingredient -> (station, station item it is)
LINKS = {
    "COKE": (R, "Coke"),
    "COKE LIGHT": (R, "Coke Light"),
    "COKE ZERO": (R, "Coke Zero"),
    "SPRITE": (R, "Sprite"),
    "ROOTBEER": (R, "Rootbeer"),
    "ROYAL": (R, "Royal"),
    "BOTTLED WATER": (R, "Bottled Water"),
    "ICED TEA POWDER": (R, "Iced Tea"),
    "1 oz cup": (R, "1 oz cup"),
    "Sml pan": (M, "Sml pan"),
    "Medium pan": (M, "Med Pan"),
    "Large pan": (M, "Lrg Pan"),
    "Donburi": (M, "Donburi sauce"),
    "16 OZ CUP": (D, "Oishii Nori Cup 16oz"),
    "20 OZ CUP": (D, "Oishii Nori Cup 20oz"),
    "LD": (D, "LD"),
    "HD": (D, "HD"),
    "OD": (D, "OD"),
    "STRAWBERRY SYRUP": (D, "Strawberry syrup"),
}
# ingredient -> (station, section); no station item to link
PLACE = {
    "MATCHA CHEESEHE CAKE": (D, "Cakes & pastries"),
    "TIRAMISU CAKE": (D, "Cakes & pastries"),
    "MATCHA CREAMPUFF": (D, "Cakes & pastries"),
    "STRAWBERRY SAUCE": (D, "Syrups, jams & sauces"),
    "Pistacio syrup": (D, "Salt & toppings"),
    "Pistacio walling": (D, "Salt & toppings"),
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase
    from app.routers.inventory import next_sort_order

    db = get_supabase()
    ings = {i["name"]: i for i in db.table("ingredients").select("id, name, station, sheet_section, sort_order").execute().data}
    items = db.table("stock_items").select("id, name, station, category, sort_order, ingredient_id, current_stock, active").execute().data
    by_station_name = {(s["station"], s["name"]): s for s in items}
    ruled = {r["stock_item_id"] for r in db.table("stock_consumption_rules").select("stock_item_id").eq("active", True).execute().data}
    changes = 0

    print("Link to the station item and take its place:")
    for name, (station, item_name) in LINKS.items():
        ing, item = ings.get(name), by_station_name.get((station, item_name))
        if not ing or not item:
            print(f"  !! {name} / {item_name}: {'ingredient' if not ing else 'station item'} not found")
            continue
        if item["ingredient_id"] not in (None, ing["id"]):
            print(f"  !! {item_name} is already linked to another ingredient -- skipped")
            continue
        if item["id"] in ruled:
            print(f"  !! {item_name} has consumption rules -- linking would deduct twice, skipped")
            continue
        place = {"station": station, "sheet_section": item["category"], "sort_order": item["sort_order"]}
        linked = item["ingredient_id"] == ing["id"]
        placed = all(ing.get(k) == v for k, v in place.items())
        if linked and placed:
            continue
        print(f"  {name:22} = {item_name:22} {station} / {item['category']} #{item['sort_order']}"
              + ("" if linked else "  (link)"))
        changes += 1
        if args.apply:
            if not linked:
                db.table("stock_items").update({"ingredient_id": ing["id"]}).eq("id", item["id"]).execute()
            db.table("ingredients").update(place).eq("id", ing["id"]).execute()

    print("Place (no station item):")
    for name, (station, section) in PLACE.items():
        ing = ings.get(name)
        if not ing:
            print(f"  !! {name} not found")
            continue
        if ing.get("station") == station and ing.get("sheet_section") == section:
            continue
        order = next_sort_order(db, station, section)
        print(f"  {name:22} -> {station} / {section} #{order}")
        changes += 1
        if args.apply:
            db.table("ingredients").update({"station": station, "sheet_section": section, "sort_order": order}).eq("id", ing["id"]).execute()

    left = sorted(n for n, i in ings.items() if not i.get("station") and n not in LINKS and n not in PLACE)
    print(f"\nStill Unsorted: {', '.join(left) or 'none'}")
    print(f"{changes} change(s){'' if args.apply else ' (dry run -- add --apply)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
