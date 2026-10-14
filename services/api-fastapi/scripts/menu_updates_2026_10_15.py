"""
Menu updates from the client (2026-10-15).

  1  Drip Tea cup sizes say what they are: LD -> "16oz Low Dose",
     HD -> "22oz High Dose", OD -> "1L Overdose". Same rows and prices, so
     past orders and recipes are untouched.
  2  Coffee is one size: Daku Choko's "Regular" -> "16 oz" (the rest of
     Cafe (16oz Iced) already says 16 oz).
  3  Dubai Chewy Cookie is a drink: moved from Desserts to Drip Tea's
     Dark Cocoa (chocolate) series as "Dubai Chewy Cookie Drink", one 16oz
     size at its current price.
  4  Online-menu extras "Nata" and "Pearl" at 25 pesos (menu_addons, shared
     with the POS add-ons).

Matcha Cheesecake is left switched off until the owner sets its price.
Re-running sync_october_menu.py would bring back the old LD/HD/OD labels.

Idempotent; matched by name. Run with:
  .venv/bin/python scripts/menu_updates_2026_10_15.py           # dry run
  .venv/bin/python scripts/menu_updates_2026_10_15.py --apply
"""
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

URL = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SECRET_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

CUP_SIZES = {"LD": "16oz Low Dose", "HD": "22oz High Dose", "OD": "1L Overdose"}
DUBAI = ("Dubai Chewy Cookie", "Dubai Chewy Cookie Drink", "Drip Tea (Dark Cocoa Series)", "16oz")
EXTRAS = (("Nata", 25), ("Pearl", 25))


def get(path: str) -> list[dict]:
    response = requests.get(f"{URL}/{path}", headers=HEADERS, timeout=30)
    response.raise_for_status()
    return response.json()


def patch(table: str, row_id: str, changes: dict, apply: bool) -> None:
    if apply:
        requests.patch(f"{URL}/{table}?id=eq.{row_id}", headers=HEADERS, json=changes, timeout=30).raise_for_status()


def main() -> None:
    apply = "--apply" in sys.argv
    products = get("products?select=id,name,category,active,product_sizes(id,size_label,price)")

    print("1. Drip Tea cup sizes")
    for product in sorted(products, key=lambda p: (p["category"], p["name"])):
        if not product["category"].startswith("Drip Tea ("):
            continue
        for size in product["product_sizes"]:
            new = CUP_SIZES.get(size["size_label"])
            if new:
                print(f"   ~ {product['name']}: {size['size_label']} -> {new}")
                patch("product_sizes", size["id"], {"size_label": new}, apply)

    print("2. Coffee size")
    for product in products:
        if product["category"] == "Cafe (16oz Iced)":
            for size in product["product_sizes"]:
                if size["size_label"] != "16 oz":
                    print(f"   ~ {product['name']}: {size['size_label']} -> 16 oz")
                    patch("product_sizes", size["id"], {"size_label": "16 oz"}, apply)

    print("3. Dubai Chewy Cookie -> drink")
    old_name, new_name, category, label = DUBAI
    match = [p for p in products if p["name"] in (old_name, new_name)]
    if not match:
        print("   ! not found")
    for product in match:
        changes = {k: v for k, v in (("name", new_name), ("category", category)) if product[k] != v}
        if changes:
            print(f"   ~ {product['name']} ({product['category']}) -> {new_name} ({category})")
            patch("products", product["id"], changes, apply)
        for size in product["product_sizes"]:
            if size["size_label"] != label:
                print(f"   ~ size {size['size_label']} -> {label} (price {size['price']} kept)")
                patch("product_sizes", size["id"], {"size_label": label}, apply)

    print("4. Online-menu extras")
    addons = {a["name"].lower(): a for a in get("menu_addons?select=id,name,price,active")}
    for name, price in EXTRAS:
        existing = addons.get(name.lower())
        if existing is None:
            print(f"   + {name} {price}")
            if apply:
                requests.post(f"{URL}/menu_addons", headers=HEADERS, json={"name": name, "price": price, "active": True},
                              timeout=30).raise_for_status()
        elif existing["active"] and float(existing["price"]) == price:
            print(f"   = {name} already listed at {price}")
        else:
            print(f"   ~ {name} -> {price}, active")
            patch("menu_addons", existing["id"], {"price": price, "active": True}, apply)

    print("\nApplied." if apply else "\nDry run only -- re-run with --apply to write.")


if __name__ == "__main__":
    main()
