"""Menu integration, step 3 of 5: add Takoyaki (Classic/Cheesy/Premium/
Assorted Platters) and Sides -- entirely new products, zero live equivalent
today, per combined_menu.md.

No recipe data exists for any of these in the client's files: the xlsx's
tako_snack-station count sheet ("TAKOSTACRUZ") only lists item NAMES for the
daily physical count (Single Box, Tako sticks, Tako mix, Tako sauce, Bonito,
Pork Floss, ...), with no per-serving quantities -- same situation as the
Donburi/Curry/Gohan/oBento gap. Per the "add priced, no recipe yet" decision
already made for that gap, applied consistently here: every product below is
created sellable at its listed price with NO recipe_items (no stock
deduction until the client supplies real quantities) and
needs_station_review=true so Menu Editing shows it as unfinished rather than
silently complete.

department/station: kitchen_station has no dedicated "tako" value (that's
only in the separate stock_station enum, which the tako_snack Station Items
already use) -- mapped to the existing 'hot_line' station like every other
fried/grilled item (Ramen, Rice Meals, Gyoza Platter), department='kitchen'.
Not a new enum value, a pragmatic reuse.

NOT done here (flagged, not silently dropped): the add-on charges the client
menu lists alongside these sections (Takoyaki Sauce/Japanese Mayo/Bonito
Flakes/Cheese Cuts; Special Oishii Nori Sauce/Special Cheese Sauce/Cheddar
Cheese/Pork Floss) belong in the existing menu_addons mechanism, same
deferral as Baked Sushi's "+nori" add-on in step 1 -- not wired here.

Run with (dry-run first, no --apply):
  py -3 services/api-fastapi/scripts/add_takoyaki_sides_menu.py
  py -3 services/api-fastapi/scripts/add_takoyaki_sides_menu.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

APPLY = "--apply" in sys.argv

DEPARTMENT = "kitchen"
STATION = "hot_line"

# (name, category, [(size_label, price), ...])
NEW_PRODUCTS: list[tuple[str, str, list[tuple[str, float]]]] = [
    # Classic Takoyaki
    ("Classic Cheese Takoyaki", "Takoyaki (Classic)", [("4 pcs", 49), ("8 pcs", 96), ("24 pcs (Platter)", 275)]),
    ("Bacon Takoyaki", "Takoyaki (Classic)", [("4 pcs", 59), ("8 pcs", 116), ("24 pcs (Platter)", 335)]),
    ("Octobits Takoyaki", "Takoyaki (Classic)", [("4 pcs", 65), ("8 pcs", 128), ("24 pcs (Platter)", 370)]),
    ("Kani Takoyaki", "Takoyaki (Classic)", [("4 pcs", 65), ("8 pcs", 128), ("24 pcs (Platter)", 370)]),
    # Cheesy Takoyaki
    ("Double Cheese Takoyaki", "Takoyaki (Cheesy)", [("4 pcs", 59), ("8 pcs", 116), ("24 pcs (Platter)", 335)]),
    ("Cheesy Bacon Takoyaki", "Takoyaki (Cheesy)", [("4 pcs", 69), ("8 pcs", 136), ("24 pcs (Platter)", 395)]),
    ("Cheesy Octo Takoyaki", "Takoyaki (Cheesy)", [("4 pcs", 69), ("8 pcs", 136), ("24 pcs (Platter)", 395)]),
    ("Cheesy Kani Takoyaki", "Takoyaki (Cheesy)", [("4 pcs", 69), ("8 pcs", 136), ("24 pcs (Platter)", 395)]),
    ("Cheesy Tori Takoyaki", "Takoyaki (Cheesy)", [("4 pcs", 69), ("8 pcs", 136), ("24 pcs (Platter)", 395)]),
    ("Cheesy Tuna Takoyaki", "Takoyaki (Cheesy)", [("4 pcs", 69), ("8 pcs", 136), ("24 pcs (Platter)", 395)]),
    # Premium Takoyaki
    ("Oishii Takoyaki", "Takoyaki (Premium)", [("4 pcs", 99), ("8 pcs", 189), ("24 pcs (Platter)", 599)]),
    ("Cheese Bomb Takoyaki", "Takoyaki (Premium)", [("4 pcs", 79), ("8 pcs", 156), ("24 pcs (Platter)", 499)]),
    ("Truffle Nori Takoyaki", "Takoyaki (Premium)", [("4 pcs", 89), ("8 pcs", 176), ("24 pcs (Platter)", 539)]),
    # Assorted platters (mixed flavors, 24pcs) -- no per-flavor split data,
    # created as an ordinary (non-bundle) product like the existing Gyoza
    # Platter, not via bundle_components.
    ("Assorted Classic Takoyaki Platter", "Takoyaki (Assorted Platters)", [("24 pcs", 375)]),
    ("Assorted Cheesy Takoyaki Platter", "Takoyaki (Assorted Platters)", [("24 pcs", 419)]),
    ("Assorted Premium Takoyaki Platter", "Takoyaki (Assorted Platters)", [("24 pcs", 539)]),
    # Sides
    ("Yakisoba", "Sides", [("1 serving", 105)]),
    ("Okonomiyaki", "Sides", [("1 serving", 95)]),
    ("Wasabi Fries", "Sides", [("1 serving", 95)]),
    ("TakoFries", "Sides", [("1 serving", 99)]),
    ("Truffle Fries", "Sides", [("1 serving", 95)]),
    ("Tempura", "Sides", [("5 pcs", 229)]),
    ("Kani Tempura", "Sides", [("5 pcs", 189)]),
    ("5pc Gyoza", "Sides", [("5 pcs", 229)]),  # distinct from the existing 32pcs "Gyoza Platter"
    ("Chicken Karaage", "Sides", [("1 serving", 149)]),
]


def main() -> None:
    sb = get_supabase()
    existing = {p["name"]: p for p in sb.table("products").select("id,name").execute().data}

    created_products = 0
    created_sizes = 0
    for name, category, sizes in NEW_PRODUCTS:
        product = existing.get(name)
        if not product:
            print(f"[NEW PRODUCT] {name} ({category})")
            created_products += 1
            if APPLY:
                product = sb.table("products").insert(
                    {
                        "name": name,
                        "category": category,
                        "station": STATION,
                        "department": DEPARTMENT,
                        "is_bundle": False,
                        "active": True,
                        "needs_station_review": True,
                    }
                ).execute().data[0]
            else:
                product = {"id": "PENDING"}
        else:
            print(f"[EXISTS] {name} -- checking sizes only (safe re-run)")

        existing_sizes = set()
        if product["id"] != "PENDING":
            existing_sizes = {
                s["size_label"]
                for s in sb.table("product_sizes").select("size_label").eq("product_id", product["id"]).execute().data
            }
        for order, (label, price) in enumerate(sizes):
            if label in existing_sizes:
                continue
            print(f"    + size {label!r} @ {price:g}")
            created_sizes += 1
            if APPLY:
                sb.table("product_sizes").insert(
                    {"product_id": product["id"], "size_label": label, "price": price, "sort_order": order}
                ).execute()

    print("")
    print("=" * 70)
    print(f"SUMMARY -- {'APPLIED' if APPLY else 'DRY RUN (pass --apply to write)'}")
    print("=" * 70)
    print(f"New products: {created_products} / {len(NEW_PRODUCTS)}")
    print(f"New sizes: {created_sizes}")
    print("All created with NO recipe_items (no stock deduction) and")
    print("needs_station_review=true -- no quantity data exists in any client file.")
    print("Add-on charges (Takoyaki Sauce, Special Oishii Nori Sauce, etc.) NOT wired --")
    print("belongs in menu_addons, deferred same as Baked Sushi's '+nori' add-on.")


if __name__ == "__main__":
    main()
