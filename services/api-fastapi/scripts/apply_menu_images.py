"""Add the owner's transparent menu photos (Oct 19 set) to products that have none.

Products that already have a photo are left alone. Each matched PNG is
resized to a 720 px WebP and written to every app's public/products folder;
products.image_path is then set to /products/<slug>.webp. Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_menu_images.py "~/Desktop/VARIX/OIshii Nori/Menu Item Images 1080 Transparent 2026-10-19"
    ... --apply
"""
import argparse
import csv
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
APPS = ("customer-menu", "landing-page", "dashboard-web")
SIZE = 720

# Photo name in item-index.csv -> product name(s), where they differ.
ALIASES = {
    "Small Sushi Platter": ["Small Platter"],
    "Medium Sushi Platter": ["Medium Platter"],
    "Large Sushi Platter": ["Large Platter"],
    "Assorted Classic Takoyaki": ["Assorted Classic Takoyaki Platter"],
    "Assorted Cheesy Takoyaki": ["Assorted Cheesy Takoyaki Platter"],
    "Assorted Premium Takoyaki": ["Assorted Premium Takoyaki Platter"],
    "Katsudon Curry": ["Katsudon Curry (Chicken)", "Katsudon Curry (Pork)"],
    "Pork Katsu": ["Pork Katsu Gohan"],
    "Chicken Katsu": ["Chicken Katsu Gohan"],
    "Chicken Tempura": ["Chicken Tempura Gohan"],
    "Cheesy Katsu Obento": ["Cheesy Katsu oBento (Chicken)", "Cheesy Katsu oBento (Pork)"],
    "Katsu Obento": ["Katsu oBento (Chicken)", "Katsu oBento (Pork)"],
    "Pork Tonkatsu Rice Meal": ["Pork Tonkatsu"],
    "Torikatsu Chicken Rice Meal": ["Torikatsu (Chicken)"],
    "Salmon Teriyaki Rice Meal": ["Salmon Teriyaki"],
    "Pork Teriyaki Rice Meal": ["Pork Teriyaki"],
    "Ika Furai Rice Meal": ["Ika Furai"],
    "Beef Teriyaki Rice Meal": ["Beef Teriyaki"],
    "Ebi Fry Rice Meal": ["Ebi Fry"],
    "Beef or Chicken Yakiniku Rice Meal": ["Beef/Chicken Yakiniku"],
    "Chicken Teriyaki Rice Meal": ["Chicken Teriyaki"],
    "Dubai Chewy Cookies Drink": ["Dubai Chewy Cookie Drink"],
    "Tiramisu Latte": ["Tiramisu Rate"],
    "Ichigo Matcha": ["Itchigo Matcha"],
    # Tea reference photos: names inferred by the image set's author.
    "Uji Matcha Reference": ["Uji Matcha"],
    "Oreo Cheesecake Reference": ["Oreo Cheesecake"],
    "Black Wintermelon Cheesecake Reference": ["Black Wintermelon Mousse"],
    "Choco Mousse Reference": ["Choco Mousse"],
    "Cheesecake Reference": ["Cheesecake"],
    "Brown Sugar Latte Reference": ["Brown Sugar Latte"],
    "Nutella Reference": ["Nutella"],
    "Cookie Dough Reference": ["Cookie Dough"],
    "Taro Cheesecake Reference": ["Taro Cheesecake"],
    "Purple Taro Reference": ["Purple Taro"],
    "Red Chocolate Reference": ["Red Chocolate"],
    "Northern Yogurt Reference": ["Northern Yogurt"],
    "Aurora Passion Reference": ["Aurora Passion"],
    "Mango Sunset Reference": ["Mango Sunset"],
    "Sunrise Lychee Reference": ["Sunrise Lychee"],
}


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def write_webp(src: str, name: str) -> None:
    from PIL import Image
    with Image.open(src) as image:
        image = image.convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS)
        for app in APPS:
            out = os.path.join(REPO, "apps", app, "client", "public", "products", name)
            image.save(out, "WEBP", quality=80, method=6)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from app.deps import get_supabase
    db = get_supabase()
    folder = os.path.expanduser(args.folder)
    with open(os.path.join(folder, "item-index.csv"), newline="") as f:
        rows = list(csv.DictReader(f))
    products = db.table("products").select("id,name,image_path").eq("active", True).execute().data
    by_name = {norm(p["name"]): p for p in products}

    changes, skipped = 0, []
    for row in rows:
        targets = [by_name.get(norm(n)) for n in ALIASES.get(row["Menu item"], [row["Menu item"]])]
        targets = [t for t in targets if t]
        if not targets:
            skipped.append(f"{row['Menu item']} (no product)")
            continue
        for product in targets:
            if product["image_path"]:
                skipped.append(f"{row['Menu item']} -> {product['name']} (already has a photo)")
                continue
            path = f"/products/{slug(product['name'])}.webp"
            print(f"  add  {row['Menu item']!r} -> {product['name']!r}  {path}")
            changes += 1
            if args.apply:
                write_webp(os.path.join(folder, row["Filename"]), path.rsplit("/", 1)[1])
                db.table("products").update({"image_path": path}).eq("id", product["id"]).is_("image_path", "null").execute()
                product["image_path"] = path
    print(f"\nSkipped {len(skipped)}:")
    for line in skipped:
        print(f"  {line}")
    print(f"\n{changes} photo(s)." + ("" if args.apply else " Dry run; re-run with --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
