"""Add/correct the manually charged takeout packaging POS items.

Dry-run by default. Apply to the shared catalog with --apply. These are sale
items only: this script creates no recipes or stock-consumption rules.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.deps import get_supabase


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    db = get_supabase()
    catalog = db.table("products").select(
        "id,name,category,station,department,active,is_bundle,product_sizes(id,size_label,price,scale_factor,sort_order)"
    ).execute().data
    bowls = [p for p in catalog if p["name"].strip().casefold() == "takeout bowl"]
    boxes = [p for p in catalog if p["name"].strip().casefold() == "takeout box"]
    if len(bowls) != 1:
        raise RuntimeError(f"Expected one existing Takeout Bowl product, found {len(bowls)}")
    if len(boxes) > 1:
        raise RuntimeError(f"Multiple Takeout Box products exist ({len(boxes)}); review manually")

    bowl = bowls[0]
    if bowl["is_bundle"] or len(bowl["product_sizes"]) != 1:
        raise RuntimeError("Existing Takeout Bowl product has unexpected bundle/size setup")
    bowl_size = bowl["product_sizes"][0]
    if float(bowl_size["price"]) != 10:
        raise RuntimeError(f"Existing Takeout Bowl is PHP {bowl_size['price']}, expected PHP 10")

    box = boxes[0] if boxes else None
    if box:
        if (box["category"], box["station"], box["department"], box["is_bundle"]) != (
            "Packaging", "hot_line", "kitchen", False
        ):
            raise RuntimeError("Existing Takeout Box classification differs; review manually")
        sizes = box["product_sizes"]
        if sizes and (len(sizes) != 1 or sizes[0]["size_label"] != "1 pc" or float(sizes[0]["price"]) != 5):
            raise RuntimeError("Existing Takeout Box size/price differs; review manually")

    print(f"Takeout Bowl: existing product, PHP 10; move category {bowl['category']!r} → 'Packaging'")
    print(f"Takeout Box: {'resume existing' if box else 'create'}, Packaging, 1 pc, PHP 5")
    print("No recipe, stock rule, or ingredient data will be written.")
    if not args.apply:
        print("Dry run only. Pass --apply to update the live POS catalog.")
        return

    db.table("products").update({"category": "Packaging"}).eq("id", bowl["id"]).execute()
    if not box:
        box = db.table("products").insert({
            "name": "Takeout Box", "category": "Packaging", "station": "hot_line",
            "department": "kitchen", "active": False, "is_bundle": False,
        }).execute().data[0]
        sizes = []
    if not sizes:
        db.table("product_sizes").insert({
            "product_id": box["id"], "size_label": "1 pc", "price": 5,
            "scale_factor": 1, "sort_order": 0,
        }).execute()
    if not box["active"]:
        db.table("products").update({"active": True}).eq("id", box["id"]).execute()

    # Verify the persisted active POS catalog and that no recipe was created.
    verified = db.table("products").select(
        "id,name,category,active,is_bundle,product_sizes(id,size_label,price)"
    ).in_("id", [bowl["id"], box["id"]]).execute().data
    by_id = {p["id"]: p for p in verified}
    for product_id, name, price in ((bowl["id"], "Takeout bowl", 10), (box["id"], "Takeout Box", 5)):
        product = by_id[product_id]
        if not product["active"] or product["category"] != "Packaging" or product["is_bundle"]:
            raise RuntimeError(f"Catalog verification failed for {name}")
        if len(product["product_sizes"]) != 1 or float(product["product_sizes"][0]["price"]) != price:
            raise RuntimeError(f"Size/price verification failed for {name}")
        size_id = product["product_sizes"][0]["id"]
        if db.table("recipe_items").select("id").eq("product_size_id", size_id).execute().data:
            raise RuntimeError(f"Unexpected recipe rows for {name}")
        print(f"Verified live POS item: {product['name']} — PHP {price}, Packaging, no recipe")


if __name__ == "__main__":
    main()
