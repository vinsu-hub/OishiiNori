"""Follow-up to the 5-script menu integration:

1. Flags 10 ingredients named in combined_menu.md's dish contents / Takoyaki
   add-ons that have no matching row in `ingredients` at all (cross-checked
   by hand against the live 102-row ingredient list) -- inserted as real
   rows with needs_review=true, a placeholder base_unit, and a note saying
   exactly where in the client menu they're named, so they're immediately
   visible in Ingredient Stock/Alerts and selectable in Menu Editing's
   Recipe tab (no recipe_items are created -- no quantities exist yet).

   2 more names from the menu (Premium Takoyaki's generic "Vegies", Crazy
   Maki's "special kani salad") are deliberately NOT auto-created here --
   too vague to name a real ingredient from; see the run's summary.

2. Adds "Salmon Box" as its own new category/product (₱1,299, one size,
   no recipe) -- its listed components ("Baked Salmon Teriyaki + Torched
   Cheesy Salmon + Salmon Roll") reference a "Salmon Roll" maki that
   doesn't exist as a product anywhere; flagged, not invented.

Run with (dry-run first, no --apply):
  py -3 services/api-fastapi/scripts/flag_missing_ingredients_and_salmon_box.py
  py -3 services/api-fastapi/scripts/flag_missing_ingredients_and_salmon_box.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

APPLY = "--apply" in sys.argv

# (name, base_unit, category, note citing where it's named in the menu)
MISSING_INGREDIENTS = [
    ("Takoyaki Sauce", "ml", "Takoyaki",
     "Classic Takoyaki add-on (₱30); also in Premium Takoyaki's Cheese Bomb/Truffle Nori contents."),
    ("Japanese Mayo", "ml", "Takoyaki",
     "Classic Takoyaki add-on (₱30); also Baked Sushi's 'Extras' line (₱30) -- kept distinct from Special mayo (house)."),
    ("Bonito Flakes", "g", "Takoyaki",
     "Classic Takoyaki add-on (₱20)."),
    ("Cheese Cuts", "pcs", "Takoyaki",
     "Classic Takoyaki add-on 'Cheese Cuts (4)' (₱15); also named in Premium Takoyaki's contents."),
    ("Special Oishii Nori Sauce", "ml", "Takoyaki",
     "Premium Takoyaki add-on (₱60); also Oishii Takoyaki's own contents."),
    ("Special Cheese Sauce", "ml", "Takoyaki",
     "Premium Takoyaki add-on (₱30); also Cheese Bomb's own contents."),
    ("Cheddar Cheese", "g", "Takoyaki",
     "Premium Takoyaki add-on (₱20); also Cheese Bomb's own contents."),
    ("Pork Floss", "g", "Takoyaki",
     "Premium Takoyaki add-on (₱20); also Oishii Takoyaki / Cheese Bomb's own contents."),
    ("Aonori", "g", "Takoyaki",
     "Named in all 3 Premium Takoyaki items' contents -- a seaweed-flake garnish, distinct from the existing 'Nori sheet'."),
    ("Truffle Oil", "ml", "Takoyaki",
     "Truffle Nori's own contents."),
]

SALMON_BOX = {
    "name": "Salmon Box",
    "category": "Salmon Box",
    "price": 1299,
    "size_label": "1 box",
}


def main() -> None:
    sb = get_supabase()

    print("=" * 70)
    print("10 missing ingredients (flagged, needs_review=true)")
    print("=" * 70)
    existing = {i["name"].lower(): i["id"] for i in sb.table("ingredients").select("id,name").execute().data}
    new_count = 0
    for name, unit, category, note in MISSING_INGREDIENTS:
        if name.lower() in existing:
            print(f"  {name}: already exists (no-op, safe re-run)")
            continue
        print(f"  [NEW] {name} (unit={unit}, category={category})")
        new_count += 1
        if APPLY:
            sb.table("ingredients").insert(
                {"name": name, "category": category, "base_unit": unit, "needs_review": True, "used_in_note": note}
            ).execute()

    print("")
    print("2 ambiguous names NOT auto-created (need a client decision, not a guess):")
    print("  - 'Vegies' (Premium Takoyaki's generic vegetable-mix content -- no specific item named)")
    print("  - 'special kani salad' (Crazy Maki's content -- could reuse Crab stick, or be a distinct prepared mix)")

    print("")
    print("=" * 70)
    print("Salmon Box")
    print("=" * 70)
    existing_product = sb.table("products").select("id").eq("name", SALMON_BOX["name"]).maybe_single().execute()
    existing_product = existing_product.data if existing_product else None
    if existing_product:
        print(f"  Salmon Box already exists (id={existing_product['id']}) -- no-op, safe re-run")
    else:
        print(f"  [NEW PRODUCT] {SALMON_BOX['name']} ({SALMON_BOX['category']}) -- {SALMON_BOX['size_label']} @ {SALMON_BOX['price']:g}")
        print("  Components per the client menu: Baked Salmon Teriyaki + Torched Cheesy Salmon + 'Salmon Roll'")
        print("  'Salmon Roll' does not exist as a product anywhere -- no recipe/bundle_components created,")
        print("  flagged needs_station_review=true rather than inventing a new maki roll to resolve it.")
        if APPLY:
            product = sb.table("products").insert(
                {
                    "name": SALMON_BOX["name"],
                    "category": SALMON_BOX["category"],
                    "station": "sushi_bar_oven",
                    "department": "kitchen",
                    "is_bundle": False,
                    "active": True,
                    "needs_station_review": True,
                }
            ).execute().data[0]
            sb.table("product_sizes").insert(
                {"product_id": product["id"], "size_label": SALMON_BOX["size_label"], "price": SALMON_BOX["price"], "sort_order": 0}
            ).execute()

    print("")
    print("=" * 70)
    print(f"SUMMARY -- {'APPLIED' if APPLY else 'DRY RUN (pass --apply to write)'}")
    print("=" * 70)
    print(f"New ingredients: {new_count} / {len(MISSING_INGREDIENTS)}")
    print(f"Salmon Box: {'created' if not existing_product else 'already existed'}")


if __name__ == "__main__":
    main()
