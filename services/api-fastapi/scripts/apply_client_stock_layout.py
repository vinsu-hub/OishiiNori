"""Put Station Items in the client's stock-sheet order (INVENTORY COFFEE GRIND.xlsx).

Each sheet is one station; items take the sheet's row order (sort_order,
migration 0079) and a section (category) so the count page reads like the
sheet: Ramen -> Proteins, Ramen base & toppings, ... The sheet has no section
headers, so SECTIONS names each run of rows by its first item. Items we
track that aren't on the sheet go right after a sibling (EXTRAS); any other
go last, under their own category. Positions step by 10 so a later item
can slot in between.
Run apply_client_stock_names.py first so the names match. Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_client_stock_layout.py "~/Downloads/INVENTORY COFFEE GRIND(1).xlsx"
    ... --apply
"""
import argparse
import os
import sys

from postgrest.exceptions import APIError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from apply_client_stock_names import norm, read_sheets  # noqa: E402

# station -> [(first item on the sheet, section name)], in sheet order.
SECTIONS = {
    "ramen_hot_line": [
        ("Chasu", "Proteins"),
        ("Black Garlic", "Ramen base & toppings"),
        ("Reg. rice", "Rice & pantry"),
        ("Rice Meal Box", "Bowls & boxes"),
        ("Spoon", "Utensils"),
        ("G.bag", "Bags, cups & supplies"),
        ("Iced Tea", "Drinks"),
    ],
    "sushi_kitchen_main": [
        ("Oishii box 4 pcs", "Boxes, platters & nori"),
        ("Breaded prawns Chiller", "Proteins & seafood"),
        ("Mozarella", "Cheese"),
        ("Teriyaki sauce", "Sauces"),
        ("Japanese Rice", "Rice"),
        ("Pipino", "Produce & fillings"),
        ("Butane", "Supplies"),
    ],
    "cafe_drinks": [
        ("LD", "Cups & lids"),
        ("Pearl", "Pearl & sweeteners"),
        ("Black tea", "Tea, creamer & mousse"),
        ("Oreo", "Toppings"),
        ("Thai", "Powders"),
        ("Mango syrup", "Syrups, jams & sauces"),
        ("Salt", "Salt & toppings"),
        ("Straw", "Straws & carriers"),
    ],
    "tako_snack": [
        ("Single Box", "Packaging"),
        ("Annori", "Batter, sauces & toppings"),
        ("Cheese Bar", "Fillings"),
        ("Fries", "Fries"),
        ("Cheese Powder", "Powders & sauces"),
    ],
}
# Items we track that the sheet doesn't list -> the sheet row they follow.
EXTRAS = {
    "sushi_kitchen_main": {"Oishii Box 6pcs": "Oishii box 4 pcs"},
    "cafe_drinks": {"Whip Cream": "Nestle cream", "Full Cream Chiller": "Full cream",
                    "Nestle Cream Chiller": "Nestle cream"},
    "tako_snack": {"Dine in Plate": "Liner", "Chili (mix)": "Mayo", "Cheese Bar Chiller": "Cheese Bar",
                   "Crabstick Freezer": "Crabstick", "Chick Nuggets Freezer": "Chick nuggets Chiller",
                   "Bacon Freezer": "Bacon Chiller"},
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("xlsx")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase
    db = get_supabase()
    try:
        db.table("stock_items").select("sort_order").limit(1).execute()
        has_sort = True
    except APIError:
        has_sort = False
        print("!! Migration 0079 not run yet: setting sections only, not the row order.")

    sheets = read_sheets(os.path.expanduser(args.xlsx))
    changes = 0
    for station, rows in sheets.items():
        starts = {norm(first): section for first, section in SECTIONS[station]}
        cols = "id,name,category" + (",sort_order" if has_sort else "")
        items = db.table("stock_items").select(cols).eq("station", station).execute().data
        by_name = {norm(i["name"]): i for i in items}
        layout: dict[str, tuple[str | None, int | None]] = {}
        section = None
        anchors: dict[str, tuple[str | None, int]] = {}
        for position, row in enumerate(rows, start=1):
            section = starts.get(norm(row["name"]), section)
            anchors[norm(row["name"])] = (section, position * 10)
            item = by_name.get(norm(row["name"]))
            if item:
                layout[item["id"]] = (section, position * 10)
            else:
                print(f"  !! {row['name']!r} is on the sheet but not in Station Items (run apply_client_stock_names.py)")
        for name, after in EXTRAS.get(station, {}).items():
            item, anchor = by_name.get(norm(name)), anchors.get(norm(after))
            if item and anchor and item["id"] not in layout:
                taken = sum(1 for v in layout.values() if v[1] is not None and anchor[1] < v[1] < anchor[1] + 10)
                layout[item["id"]] = (anchor[0], anchor[1] + 1 + taken)
        print(f"\n== {station}")
        for item in sorted(items, key=lambda i: layout.get(i["id"], (None, 10**6))[1] or 10**6):
            section, position = layout.get(item["id"], (item["category"], None))
            update = {}
            if item["category"] != section:
                update["category"] = section
            if has_sort and item.get("sort_order") != position:
                update["sort_order"] = position
            if update:
                changes += 1
                where = f"{position:>4}" if position is not None else "last"
                print(f"  {where} {item['name']:<28} {section or '(no section)'}")
                if args.apply:
                    db.table("stock_items").update(update).eq("id", item["id"]).execute()
    print(f"\n{changes} change(s)." + ("" if args.apply else " Dry run; re-run with --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
