"""Add the owner's four Ramen items without inventing recipes. Dry-run by default.

Run from services/api-fastapi: .venv/bin/python scripts/add_ramen_20261008.py --apply
Creates inactive products first, adds their size, then activates. Re-runs verify
existing rows rather than overwriting menu edits. Never modifies recipes/stock.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.deps import get_supabase

ITEMS = {"Tantanmen": 209, "Kuro Chasumen": 209, "Spicy Miso": 199, "Black Garlic": 289}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    db = get_supabase()
    catalog = db.table("products").select("id,name,category,station,department,active,product_sizes(id,size_label,price)").execute().data
    planned = []
    for name, price in ITEMS.items():
        matches = [p for p in catalog if p["name"].strip().casefold() == name.casefold()]
        if len(matches) > 1:
            raise RuntimeError(f"Multiple products match {name}; review manually")
        product = matches[0] if matches else None
        if product:
            if (product["category"], product["station"], product["department"]) != ("Ramen", "hot_line", "kitchen"):
                raise RuntimeError(f"Existing {name} has different classification; review manually")
            sizes = product["product_sizes"]
            if sizes and (len(sizes) != 1 or sizes[0]["size_label"] != "1 bowl" or float(sizes[0]["price"]) != price):
                raise RuntimeError(f"Existing {name} has different sizes/prices; review manually")
        planned.append((name, price, product))
        print(f"{name}: PHP {price}, Ramen, 1 bowl; {'verify/resume' if product else 'create'}, no recipe changes")
    if not args.apply:
        print("Dry run only. Pass --apply to add these menu entries.")
        return
    for name, price, product in planned:
        if not product:
            product = db.table("products").insert({"name": name, "category": "Ramen", "station": "hot_line", "department": "kitchen", "active": False, "is_bundle": False}).execute().data[0]
            product["product_sizes"] = []
        if not product["product_sizes"]:
            db.table("product_sizes").insert({"product_id": product["id"], "size_label": "1 bowl", "price": price, "scale_factor": 1, "sort_order": 0}).execute()
        if not product["active"]:
            db.table("products").update({"active": True}).eq("id", product["id"]).execute()
        print(f"Active: {name} — PHP {price}")


if __name__ == "__main__":
    main()
