"""Menu integration, step 1 of 5: reprice/resize/recategorize EXISTING
products to match the client's real combined menu
(combined_menu.md / INVENTORY COFFEE GRIND.xlsx / DripTea manual).

Scope, deliberately narrow -- no new products, no recipe_items changes
(that's step 2, refresh_recipes_from_client_xlsx.py):
  1. Reprice every matched product/size to the client's listed price.
  2. Add the missing "4 pcs" size tier to the 7 classic maki rolls that
     have one (Futo Maki is the one exception -- the client doc gives it
     only a single tier, oddly labeled "6pcs", so its existing size is
     relabeled+repriced instead of gaining a second tier).
  3. Merge "Baked Sushi (New)" into "Baked Sushi" (the client doc treats
     all 5 baked items as one section).
  4. Fix the Sushi Boat pcs-count labels (client: 32/64 pcs; live: 34/62).
  5. Remove seed_drinks_placeholder.py's guessed bottled softdrinks --
     confirmed absent from the client's real menu entirely.

Idempotent: every write is either an update-by-id (safe to repeat) or an
insert guarded by a "does this size_label already exist" check.

Uses the Supabase REST API via the app's own service-role client
(app.deps.get_supabase()) -- NOT psycopg2/direct Postgres. The
SUPABASE_DB_PASSWORD in .env.local does not authenticate against either
the direct host or any pooler region (verified, wrong/stale credential),
while this exact REST path is what the live FastAPI app itself uses for
every one of these tables, confirmed working with a live insert+delete
test against `ingredients` before this script was written.

Run with (dry-run first, no --apply):
  py -3 services/api-fastapi/scripts/update_menu_prices_and_categories.py
  py -3 services/api-fastapi/scripts/update_menu_prices_and_categories.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

APPLY = "--apply" in sys.argv

# ---------------------------------------------------------------------------
# 1. Plain reprices: product name -> {size_label: new_price}
# ---------------------------------------------------------------------------
REPRICE = {
    # Torched Maki
    "Torched Cheesy Tuna Maki": {"8 pcs": 309},
    "Torched Cheesy Tempura Maki": {"8 pcs": 309},
    "Torched Cheesy Salmon Maki": {"8 pcs": 319},
    # Oishii Salad
    "Kani Salad": {"1 serving": 159},
    "Oishii Salad": {"1 serving": 169},
    "Spicy Tuna Roll": {"1 serving": 149},
    # Oishii Platter (Bundle) -- Sushi Platters
    "Small Platter": {"32 pcs assorted": 799},
    "Medium Platter": {"48 pcs assorted": 1299},
    "Large Platter": {"64 pcs assorted": 1599},
    # Gyoza Platter (standalone, not a bundle)
    "Gyoza Platter": {"32 pcs": 1099},
    # Baked Sushi (Small/Medium/Large all repriced identically except Salmon Teriyaki)
    "Baked Kani Sushi": {"Small (2–3 pax)": 429, "Medium (4–5 pax)": 799, "Large (6–8 pax)": 999},
    "Oishii Baked Sushi": {"Small (2–3 pax)": 429, "Medium (4–5 pax)": 799, "Large (6–8 pax)": 999},
    "Spicy Tuna Baked Sushi": {"Small (2–3 pax)": 429, "Medium (4–5 pax)": 799, "Large (6–8 pax)": 999},
    "Cheesy Baked Spicy Scallop": {"Small (2–3 pax)": 429, "Medium (4–5 pax)": 799, "Large (6–8 pax)": 999},
    "Baked Salmon Teriyaki": {"Small (2–3 pax)": 499, "Medium (4–5 pax)": 899, "Large (6–8 pax)": 1049},
    # Ramen
    "Beef Ramen": {"1 bowl": 199},
    "Chasu Ramen": {"1 bowl": 199},
    "Tonkatsu Ramen": {"1 bowl": 199},
    "Torikatsu Ramen": {"1 bowl": 199},
    "Angus Ramen": {"1 bowl": 289},
    "Oishii Nori Ramen": {"1 bowl": 289},
    "Seafood Ramen": {"1 bowl": 289},
    # Rice Meals (Cheesy Katsu w/ Rice deliberately excluded -- not mentioned
    # in the client's "Rice Meal" section at all; treated as unchanged, not dropped)
    "Beef Teriyaki": {"1 plate": 199},
    "Beef/Chicken Yakiniku": {"1 plate": 199},
    "Chicken Teriyaki": {"1 plate": 199},
    "Ebi Fry": {"1 plate": 199},
    "Ika Furai": {"1 plate": 199},
    "Pork Teriyaki": {"1 plate": 199},
    "Pork Tonkatsu": {"1 plate": 199},
    "Torikatsu (Chicken)": {"1 plate": 199},
    "Salmon Teriyaki": {"1 plate": 289},
    # Cafe (16oz Iced) -- Pastillas Latte and Chocolate Pistachio Mousse are
    # deliberately excluded: not mentioned anywhere in the client doc, so
    # treated as unchanged rather than dropped.
    "Amerikano": {"16 oz": 120},
    "Caramel Macchiato (Kyarameru Makiato)": {"16 oz": 135},
    "Dark Mocha (Daku Moka)": {"16 oz": 135},
    "Spanish Latte (Supein Rate)": {"16 oz": 135},
    # Client doc mislabels this "Shi Soruto Rate (Spanish Latte)" -- the live
    # product is already correctly named Sea Salt Latte; keeping live naming,
    # applying the client's price.
    "Sea Salt Latte (Shi Soruto Rate)": {"16 oz": 135},
    # Client's "Non-Coffee" section lists Matcha Rate at 179 (vs this
    # product's current 120) -- a real ~49% jump, flagged in the report below.
    "Matcha Latte (Matcha Rate)": {"16 oz": 179},
}

# Every classic maki roll except Futo Maki: client gives 4pcs AND 8pcs prices.
# (product name -> (4pcs price, 8pcs price))
MAKI_TWO_TIER = {
    "Torikatsu Maki": (94, 169),
    "Spicy Tuna": (99, 172),
    "California Maki": (109, 189),
    "Oishii Maki": (112, 198),
    "Dragon Maki": (109, 189),
    "Crunchy Kani Maki": (119, 209),
    "Crazy Maki": (115, 207),
}
# Futo Maki: client gives only one tier, oddly labeled "6pcs" at 115php, with
# an explicit "—" (not offered) in the 8pcs column -- so its existing "8 pcs"
# size is relabeled to "6 pcs" and repriced, not given a second tier.
FUTO_MAKI_SINGLE_TIER = ("6 pcs", 115)

# Sushi Boat: client's pcs counts differ from live's -- fix the label text,
# keep the "..., classic maki flavors" suffix, reprice to match.
SUSHI_BOAT_FIXES = {
    "Small Sushi Boat": ("32 pcs, classic maki flavors", 1199),
    "Medium Sushi Boat": ("64 pcs, classic maki flavors", 1999),
}

# seed_drinks_placeholder.py's guessed bottled softdrinks -- absent from the
# client's real menu entirely, per the "Remove them" decision.
PLACEHOLDER_DRINKS_TO_REMOVE = [
    "Coke (Regular, in can)",
    "Coke Zero (in can)",
    "Sprite (in can)",
    "Royal (in can)",
    "Mountain Dew (in can)",
    "Sarsi (in can)",
    "Pineapple Juice (bottled)",
    "Bottled Water (500ml)",
    "Bottled Water (1L)",
    "Iced Tea (bottled)",
]


def pct_change(old: float, new: float) -> float:
    return (new - old) / old * 100 if old else float("inf")


def main() -> None:
    sb = get_supabase()
    products = sb.table("products").select("id,name,category,product_sizes(id,size_label,price,sort_order)").execute().data
    by_name = {p["name"]: p for p in products}

    report: list[str] = []
    big_jumps: list[str] = []

    def log(line: str) -> None:
        report.append(line)
        print(line)

    def size_by_label(product: dict, label: str) -> dict | None:
        return next((s for s in product["product_sizes"] if s["size_label"] == label), None)

    def apply_price(product_name: str, size_label: str, new_price: float) -> None:
        product = by_name.get(product_name)
        if not product:
            log(f"  [MISSING PRODUCT] {product_name!r} not found in live catalog -- skipped")
            return
        size = size_by_label(product, size_label)
        if not size:
            log(f"  [MISSING SIZE] {product_name!r} has no size {size_label!r} -- skipped (existing sizes: "
                f"{[s['size_label'] for s in product['product_sizes']]})")
            return
        old_price = float(size["price"])
        if old_price == new_price:
            return
        change = pct_change(old_price, new_price)
        line = f"  {product_name} ({size_label}): {old_price:g} -> {new_price:g}  ({change:+.0f}%)"
        log(line)
        if abs(change) > 40:
            big_jumps.append(line)
        if APPLY:
            sb.table("product_sizes").update({"price": new_price}).eq("id", size["id"]).execute()

    def insert_size(product_name: str, size_label: str, price: float, sort_order: int) -> None:
        product = by_name.get(product_name)
        if not product:
            log(f"  [MISSING PRODUCT] {product_name!r} not found -- skipped")
            return
        if size_by_label(product, size_label):
            return  # already exists (idempotent re-run)
        log(f"  {product_name}: + new size {size_label!r} @ {price:g}")
        if APPLY:
            sb.table("product_sizes").insert(
                {"product_id": product["id"], "size_label": size_label, "price": price, "sort_order": sort_order}
            ).execute()

    def relabel_size(product_name: str, old_label: str, new_label: str, new_price: float) -> None:
        product = by_name.get(product_name)
        if not product:
            log(f"  [MISSING PRODUCT] {product_name!r} not found -- skipped")
            return
        size = size_by_label(product, old_label) or size_by_label(product, new_label)
        if not size:
            log(f"  [MISSING SIZE] {product_name!r} has neither {old_label!r} nor {new_label!r} -- skipped")
            return
        old_price = float(size["price"])
        change = pct_change(old_price, new_price)
        line = f"  {product_name}: {size['size_label']!r}@{old_price:g} -> {new_label!r}@{new_price:g}  ({change:+.0f}%)"
        log(line)
        if abs(change) > 40:
            big_jumps.append(line)
        if APPLY:
            sb.table("product_sizes").update({"size_label": new_label, "price": new_price}).eq("id", size["id"]).execute()

    log("=" * 70)
    log("1. Plain reprices")
    log("=" * 70)
    for name, sizes in REPRICE.items():
        for size_label, new_price in sizes.items():
            apply_price(name, size_label, new_price)

    log("")
    log("=" * 70)
    log("2. Classic maki rolls: reprice 8pcs, add 4pcs tier")
    log("=" * 70)
    for name, (price_4pcs, price_8pcs) in MAKI_TWO_TIER.items():
        apply_price(name, "8 pcs", price_8pcs)
        insert_size(name, "4 pcs", price_4pcs, sort_order=0)
    log("")
    log("Futo Maki: client gives only a single, oddly-labeled '6pcs' tier "
        "(explicit '—' in the 8pcs column) -- relabeling instead of adding a tier:")
    relabel_size("Futo Maki", "8 pcs", FUTO_MAKI_SINGLE_TIER[0], FUTO_MAKI_SINGLE_TIER[1])

    log("")
    log("=" * 70)
    log("3. Merge 'Baked Sushi (New)' into 'Baked Sushi'")
    log("=" * 70)
    scallop = by_name.get("Cheesy Baked Spicy Scallop")
    if scallop and scallop["category"] != "Baked Sushi":
        log(f"  Cheesy Baked Spicy Scallop: category {scallop['category']!r} -> 'Baked Sushi'")
        if APPLY:
            sb.table("products").update({"category": "Baked Sushi"}).eq("id", scallop["id"]).execute()
    elif scallop:
        log("  Cheesy Baked Spicy Scallop already in 'Baked Sushi' (no-op, safe re-run)")

    log("")
    log("=" * 70)
    log("4. Sushi Boat pcs-count fixes")
    log("=" * 70)
    for name, (new_label, new_price) in SUSHI_BOAT_FIXES.items():
        product = by_name.get(name)
        if not product:
            log(f"  [MISSING PRODUCT] {name!r} not found -- skipped")
            continue
        old_size = product["product_sizes"][0]
        relabel_size(name, old_size["size_label"], new_label, new_price)

    log("")
    log("=" * 70)
    log("5. Remove placeholder bottled softdrinks (absent from client menu)")
    log("=" * 70)
    for name in PLACEHOLDER_DRINKS_TO_REMOVE:
        product = by_name.get(name)
        if not product:
            log(f"  {name}: already absent (no-op, safe re-run)")
            continue
        log(f"  Deleting product: {name} (id={product['id']})")
        if APPLY:
            # product_sizes has ON DELETE CASCADE from products; no recipe_items
            # exist for these (Station Item / no-BOM pattern), confirmed earlier.
            sb.table("products").delete().eq("id", product["id"]).execute()

    log("")
    log("=" * 70)
    log(f"SUMMARY -- {'APPLIED' if APPLY else 'DRY RUN (pass --apply to write)'}")
    log("=" * 70)
    log(f"Large price jumps (>40%), flagged for manual sanity-check ({len(big_jumps)}):")
    for line in big_jumps:
        log("  ! " + line.strip())
    if not big_jumps:
        log("  (none)")

    log("")
    log("Left deliberately untouched (not mentioned in the client doc):")
    log("  - Pastillas Latte (Pasutiriasu Rate), Chocolate Pistachio Mousse")
    log("  - Cheesy Katsu w/ Rice (Rice Meals)")
    log("  - 'Test' category (PNL Test Item, PNL Test Item Prod) -- pre-existing, unrelated to this import")

    log("")
    log("Not handled by this script (deferred to later steps per the plan):")
    log("  - Recipe rebuilds (step 2)")
    log("  - Net-new items: Large Sushi Boat, California Platter, Kani Salad Platter,")
    log("    Salmon Box, new cafe/dessert drinks (Tiramisu/Daku Choko/Ichigo Rate/etc.)")
    log("  - +1/2/3 nori add-on charge on Baked Sushi sizes (belongs in menu_addons, not here)")
    log("  - Takoyaki, Donburi, Curry, Gohan, oBento, Drip Tea (steps 3-5)")


if __name__ == "__main__":
    main()
