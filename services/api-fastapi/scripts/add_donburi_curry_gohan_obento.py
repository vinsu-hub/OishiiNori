"""Menu integration, step 4 of 5: add Donburi, Kare Raisu/Curry, Gohan, and
oBento -- 12 net-new products from combined_menu.md, zero recipe-quantity
data in any client file (unlike Takoyaki/Sides, there isn't even a station
count-sheet with these item names on it).

Per the "add priced, no recipe yet" decision: created sellable at the
client's listed price with NO recipe_items and needs_station_review=true.

Run with (dry-run first, no --apply):
  py -3 services/api-fastapi/scripts/add_donburi_curry_gohan_obento.py
  py -3 services/api-fastapi/scripts/add_donburi_curry_gohan_obento.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

APPLY = "--apply" in sys.argv

DEPARTMENT = "kitchen"
STATION = "hot_line"

NEW_PRODUCTS: list[tuple[str, str, list[tuple[str, float]]]] = [
    # Donburi -- "+10php for takeout/delivery" noted on the client menu; the
    # system has no channel-conditional pricing mechanism, so these are
    # dine-in base prices only (flagged as a real limitation in the summary).
    ("Tendon", "Donburi", [("1 bowl", 209)]),
    ("Gyudon", "Donburi", [("1 bowl", 209)]),
    ("Katsudon", "Donburi", [("1 bowl", 199)]),
    # Kare Raisu / Curry
    ("Ebi Fry Curry", "Kare Raisu / Curry", [("1 plate", 229)]),
    ("Beef Curry", "Kare Raisu / Curry", [("1 plate", 229)]),
    ("Katsudon Curry (Pork or Chicken)", "Kare Raisu / Curry", [("1 plate", 219)]),
    # Gohan -- a cheaper rice-bowl tier, distinct from the existing "Rice Meals" plates
    ("Pork Katsu Gohan", "Gohan", [("1 bowl", 89)]),
    ("Chicken Katsu Gohan", "Gohan", [("1 bowl", 85)]),
    ("Chicken Tempura Gohan", "Gohan", [("1 bowl", 85)]),
    # oBento -- bundles 2pcs takoyaki with a katsu item
    ("Cheesy Katsu oBento (Pork or Chicken)", "oBento", [("1 box (w/ 2pcs Takoyaki)", 115)]),
    ("Katsu oBento (Pork or Chicken)", "oBento", [("1 box (w/ 2pcs Takoyaki)", 99)]),
    ("Chicken Tempura oBento", "oBento", [("1 box (w/ 2pcs Takoyaki)", 99)]),
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
    print("All created with NO recipe_items and needs_station_review=true.")
    print("The client menu's '+10php takeout/delivery' surcharge on Donburi/Curry")
    print("is NOT implemented -- the system has no channel-conditional pricing today.")


if __name__ == "__main__":
    main()
