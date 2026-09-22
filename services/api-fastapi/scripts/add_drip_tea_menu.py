"""Menu integration, step 5 of 5: add Drip Tea -- a second brand with zero
presence in the system until now. 29 SKUs across 7 series
(combined_menu.md), all department='cafe', station='cafe_bar',
same storefront/POS/cart per the "no new department/surface" decision.

Recipe source: DRIPTEA MANUAL FOR FRACNHISEE (1).docx. A plain python-docx
`.tables` read only finds 2 top-level tables (23 paragraphs' worth of
visible text), but 15 more tables are NESTED inside those 2 tables' cells
(python-docx's `.tables` doesn't recurse) -- walked explicitly here via
`table.rows[i].cells[j].tables`. Once walked, the structure is completely
clean: each nested table is two drinks side-by-side (cols 0-3 = drink A
name/LD/HD/OD, col 4 blank separator, cols 5-8 = drink B), a real find
confirmed by direct inspection, not a guess. LD/HD/OD (Low/High/Over Dose)
are relabeled Small/Medium/Large for the customer-facing size, matching
every other product's size convention and combined_menu.md's own "Small /
Medium / Large" framing.

A SYSTEMATIC ARTIFACT: several ingredient rows appear twice in a row with
the IDENTICAL quantity (e.g. "PEARL 1/2 SCOOP" on two consecutive lines) --
a merged-cell rendering artifact in the source docx, not a real two-step
addition (unlike Baked Sushi's genuinely-repeated "Mayo" lines in step 2,
which had DIFFERENT quantities per occurrence). De-duplicated here, not
summed. Where two occurrences of the same ingredient have DIFFERENT
quantities (e.g. Nutella Milktea's two distinct "Nutella" additions), they
ARE genuinely summed, same convention as step 2.

Since every Drip Tea ingredient is brand new, its base_unit is simply
defined as whatever the card literally uses (scoop/ml/stirrer) -- there's
no pre-existing ingredient to unit-mismatch against, unlike step 2's Oishii
Nori rebuild. "Ice" (given as a fill PERCENTAGE, not a weight/volume) is
deliberately NOT modeled as a recipe ingredient -- a % fill level isn't a
trackable stock quantity, and fabricating one would misrepresent the card.

9 of 29 SKUs have no card data at all (Purple Taro, Oreo Matcha, Matcha
Latte, Thai Cheesecake, Thai Latte, Cocoa Milktea, Dark Oreo Mousse, Supreme
Cocoa, Black Wintermelon Mousse) -- per the "infer from sibling, flag
needs_review" decision, each gets a recipe estimated by analogy to its
closest sibling drink, every line flagged needs_review=true with a note
naming the analogy, clearly distinct from the 18 card-sourced recipes.
2 SKUs are marked "(Not Available)" on the client menu (Matcha Black
Mousse, Thai Black Mousse) -- created inactive (active=false) rather than
omitted, so the definition exists for whenever the client re-enables them.

Run with (dry-run first, no --apply):
  py -3 services/api-fastapi/scripts/add_drip_tea_menu.py
  py -3 services/api-fastapi/scripts/add_drip_tea_menu.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

APPLY = "--apply" in sys.argv
DEPARTMENT = "cafe"
STATION = "cafe_bar"
SIZE_LABELS = ["Small", "Medium", "Large"]  # LD, HD, OD

# ---------------------------------------------------------------------------
# Series -> (drink name, [(small_price, medium_price, large_price)]) -- from
# combined_menu.md. "(Not Available)" drinks are still created, inactive.
# ---------------------------------------------------------------------------
SERIES_PRICING = {
    "Classic": {
        "price": (94, 104, 114),
        "drinks": ["Pearl Milktea", "Wintermelon", "Okinawa", "Thai Milktea", "Hokkaido", "Uji Matcha"],
    },
    "Premium": {
        "price": (104, 114, 154),
        "drinks": ["Brown Sugar Latte", "Nutella", "Oreo Cheesecake", "Black Wintermelon Mousse", "Cheesecake", "Choco Mousse"],
    },
    "Signature": {
        "price": (104, 114, 154),
        "drinks": ["Cookie Dough", "Red Chocolate", "Taro Cheesecake", "Purple Taro"],
    },
    "Passion": {
        "price": (104, 114, 144),
        "drinks": ["Northern Yogurt", "Sunrise Lychee", "Aurora Passion", "Mango Sunset"],
    },
}
# Matcha/Thai/Dark Cocoa Series have per-drink prices, not one flat series price.
INDIVIDUAL_PRICING = {
    ("Matcha Series", "Matcha Black Mousse"): (114, 124, 164),  # (Not Available)
    ("Matcha Series", "Oreo Matcha"): (114, 124, 164),
    ("Matcha Series", "Matcha Latte"): (104, 114, 154),
    ("Thai Series", "Thai Cheesecake"): (104, 114, 154),
    ("Thai Series", "Thai Black Mousse"): (114, 124, 164),  # (Not Available)
    ("Thai Series", "Thai Latte"): (104, 114, 154),
    ("Dark Cocoa Series", "Cocoa Milktea"): (104, 114, 154),
    ("Dark Cocoa Series", "Dark Oreo Mousse"): (114, 124, 164),
    ("Dark Cocoa Series", "Supreme Cocoa"): (104, 114, 154),
}
NOT_AVAILABLE = {"Matcha Black Mousse", "Thai Black Mousse"}

# ---------------------------------------------------------------------------
# Real per-size recipes, transcribed from the docx's nested tables (Small,
# Medium, Large = LD, HD, OD). Ingredient names are the card's own labels;
# ALIAS below resolves them to canonical ingredient names (mostly 1:1, a few
# merged e.g. "Pearl"/"Milktea" shared across every drink that uses them).
# ---------------------------------------------------------------------------
REAL_RECIPES: dict[str, list[tuple[str, float, float, float]]] = {
    "Okinawa": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Okinawa Flavor", 1.5, 2, 3), ("Fructose", 10, 20, 40)],
    "Hokkaido": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Hokkaido Flavor", 1.5, 2, 3), ("Fructose", 10, 20, 40)],
    "Uji Matcha": [("Pearl", 0.5, 1, 2), ("Milktea", 100, 150, 200), ("Matcha Powder (Drip Tea)", 1.5, 2, 3), ("Fructose", 5, 10, 20)],
    "Pearl Milktea": [("Pearl", 1, 1, 2), ("Milktea", 150, 200, 300), ("Fructose", 30, 35, 70)],
    "Thai Milktea": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Thai Flavor", 1.5, 2, 3), ("Fructose", 10, 20, 40)],
    "Wintermelon": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("W.M Syrup", 20, 30, 60), ("Fructose", 10, 20, 40)],
    "Red Chocolate": [("Pearl", 0.5, 1, 2), ("Hot Water", 100, 150, 300), ("Red Choco / Creamer", 1.5, 2, 3),
                       ("Fructose", 10, 20, 50), ("Mousse", 2, 3, 5), ("Cookie", 0.75, 1, 2)],
    "Cookie Dough": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("C.D Syrup", 20, 30, 50),
                      ("Mousse", 2, 3, 5), ("Cookie", 0.75, 1, 2)],
    "Taro Cheesecake": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Taro Flavor", 1.5, 2, 3),
                         ("Fructose", 10, 20, 40), ("Mousse", 1, 2, 3)],
    "Cheesecake": [("Pearl", 1, 1, 2), ("Milktea", 150, 200, 300), ("Fructose", 30, 35, 70), ("Mousse", 3, 4, 5)],
    "Oreo Cheesecake": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Oreo Crumble", 0.5, 1, 1.5),
                         ("Fructose", 30, 35, 70), ("Mousse", 2, 3, 5)],
    "Nutella": [("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Nutella Sauce", 1.75, 2.5, 4), ("Fructose", 20, 30, 50)],
    "Choco Mousse": [("Pearl", 0.5, 1, 2), ("Hot Water", 100, 150, 250), ("Cocoa / Creamer", 1, 2, 3),
                      ("Fructose", 15, 20, 35), ("Mousse", 2, 3, 5)],
    "Brown Sugar Latte": [("Pearl", 1, 1.5, 3), ("B.S Syrup", 20, 25, 55), ("Full Cream", 120, 150, 300), ("Mousse", 2, 3, 5)],
    "Aurora Passion": [("Star Jelly", 0.5, 1, 1.5), ("Green Tea", 100, 150, 250), ("Passion Syrup", 20, 30, 50),
                        ("Yogurt", 10, 20, 30), ("Fructose", 5, 10, 15), ("Butterfly Pea", 40, 80, 120)],
    "Mango Sunset": [("Star Jelly", 0.5, 1, 1.5), ("Green Tea", 100, 150, 250), ("Mango Syrup", 20, 30, 50),
                      ("Yogurt", 10, 20, 30), ("Fructose", 5, 10, 15), ("Hibiscus", 40, 80, 120)],
    "Sunrise Lychee": [("Star Jelly", 0.5, 1, 1.5), ("Green Tea", 100, 150, 250), ("Lychee Syrup", 20, 30, 50),
                        ("Yogurt", 10, 20, 30), ("Fructose", 5, 10, 15), ("Hibiscus", 40, 80, 120)],
    "Northern Yogurt": [("Star Jelly", 0.5, 1, 1.5), ("Green Tea", 100, 150, 250), ("Yogurt", 30, 40, 70),
                         ("Fructose", 20, 30, 50), ("Butterfly Pea", 40, 80, 120)],
}

# The 9 SKUs with no card data: estimated by analogy, EVERY line flagged.
INFERRED_RECIPES: dict[str, tuple[str, list[tuple[str, float, float, float]]]] = {
    "Purple Taro": ("Taro Cheesecake (without the cheesecake mousse topping)", [
        ("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Taro Flavor", 1.5, 2, 3), ("Fructose", 10, 20, 40)]),
    "Oreo Matcha": ("Oreo Cheesecake's Oreo + Uji Matcha's Matcha, on a shared milktea base", [
        ("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Matcha Powder (Drip Tea)", 1.5, 2, 3), ("Oreo Crumble", 0.5, 1, 1.5), ("Fructose", 10, 20, 40)]),
    "Matcha Latte": ("Uji Matcha's matcha component, milk-based (no pearls/milktea-brew, per 'Latte' naming)", [
        ("Milk", 150, 200, 300), ("Matcha Powder (Drip Tea)", 1.5, 2, 3)]),
    "Thai Cheesecake": ("Thai Milktea's Thai flavor + Cheesecake's Mousse", [
        ("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Thai Flavor", 1.5, 2, 3), ("Fructose", 10, 20, 40), ("Mousse", 3, 4, 5)]),
    "Thai Latte": ("Thai Milktea's Thai flavor, milk-based (no pearls/milktea-brew, per 'Latte' naming)", [
        ("Milk", 150, 200, 300), ("Thai Flavor", 1.5, 2, 3)]),
    "Cocoa Milktea": ("Choco Mousse's Cocoa/Creamer component, on a milktea base instead of hot water + mousse", [
        ("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Cocoa / Creamer", 1, 2, 3), ("Fructose", 15, 20, 35)]),
    "Dark Oreo Mousse": ("Oreo Cheesecake's Oreo + Choco Mousse's Cocoa/Creamer and Mousse", [
        ("Pearl", 0.5, 1, 2), ("Hot Water", 100, 150, 250), ("Cocoa / Creamer", 1, 2, 3), ("Oreo Crumble", 0.5, 1, 1.5), ("Fructose", 15, 20, 35), ("Mousse", 2, 3, 5)]),
    "Supreme Cocoa": ("Choco Mousse's Cocoa/Creamer, with Mousse added (a 'Supreme' tier)", [
        ("Pearl", 0.5, 1, 2), ("Milktea", 150, 200, 300), ("Cocoa / Creamer", 1, 2, 3), ("Fructose", 15, 20, 35), ("Mousse", 2, 3, 5)]),
    "Black Wintermelon Mousse": ("Wintermelon's syrup + a Mousse/Charcoal variant (cost table confirms Winter.M/Charcoal/Mousse line items, but gives no quantities)", [
        ("W.M Syrup", 20, 20, 20), ("Charcoal Powder", 1, 1.5, 2), ("Mousse", 2, 3, 5)]),
}

# card name -> canonical ingredient name + unit. "Milk"/"Water" reuse the
# existing generic Oishii Nori Cafe ingredients (genuinely shared items);
# everything else is Drip-Tea-specific and new.
ALIAS: dict[str, tuple[str, str]] = {
    "Pearl": ("Pearl (tapioca)", "scoop"),
    "Milktea": ("Milktea base (batch-prepped)", "ml"),
    "Fructose": ("Fructose (Drip Tea)", "ml"),
    "Mousse": ("Mousse mix (Drip Tea)", "scoop"),
    "Hot Water": ("Water", "ml"),
    "Milk": ("Milk", "ml"),
    "Cookie": ("Cookie Crumble", "scoop"),
    "Green Tea": ("Green Tea (batch-brewed)", "ml"),
    "Yogurt": ("Yogurt Syrup", "ml"),
    "Butterfly Pea": ("Butterfly Pea Tea (batch-brewed)", "ml"),
    "Hibiscus": ("Hibiscus Tea (batch-brewed)", "ml"),
    "Full Cream": ("Full Cream Milk", "ml"),
}


# Explicit units for every ingredient name used directly in the raw recipe
# data below that ISN'T going through ALIAS (i.e. names already written as
# their own canonical form) -- taken from the source card's own unit per
# name, not guessed. A name missing here is a real gap (falls through to
# "g" with a loud warning printed), not a silent default.
UNIT_BY_CANONICAL_NAME = {
    "Okinawa Flavor": "scoop",
    "Hokkaido Flavor": "scoop",
    "Matcha Powder (Drip Tea)": "scoop",
    "Thai Flavor": "scoop",
    "Taro Flavor": "scoop",
    "W.M Syrup": "ml",
    "Red Choco / Creamer": "scoop",
    "Cocoa / Creamer": "scoop",
    "C.D Syrup": "ml",
    "Oreo Crumble": "scoop",
    "Nutella Sauce": "stirrer",  # card's own unit -- a swizzle-stick dose, not ml/scoop
    "B.S Syrup": "ml",
    "Passion Syrup": "ml",
    "Mango Syrup": "ml",
    "Lychee Syrup": "ml",
    "Charcoal Powder": "g",  # no card unit at all (Black Wintermelon Mousse is inferred) -- g is a judgment call, already flagged needs_review at the recipe level
    "Star Jelly": "scoop",
}


def resolve(card_name: str) -> tuple[str, str]:
    if card_name in ALIAS:
        return ALIAS[card_name]
    if card_name in UNIT_BY_CANONICAL_NAME:
        return card_name, UNIT_BY_CANONICAL_NAME[card_name]
    print(f"    [WARNING] no unit defined for {card_name!r} -- defaulting to 'g', VERIFY this")
    return card_name, "g"


def main() -> None:
    sb = get_supabase()
    products = {p["name"]: p for p in sb.table("products").select("id,name").execute().data}
    ingredients = {i["name"].lower(): i["id"] for i in sb.table("ingredients").select("id,name").execute().data}

    new_products = 0
    new_sizes = 0
    new_ingredients = 0
    recipe_lines = 0

    def ensure_product(name: str, category: str, prices: tuple[float, float, float], active: bool) -> dict:
        nonlocal new_products, new_sizes
        product = products.get(name)
        if not product:
            print(f"[NEW PRODUCT] {name} ({category}){' [INACTIVE -- Not Available]' if not active else ''}")
            new_products += 1
            if APPLY:
                product = sb.table("products").insert(
                    {"name": name, "category": category, "station": STATION, "department": DEPARTMENT,
                     "is_bundle": False, "active": active, "needs_station_review": False}
                ).execute().data[0]
            else:
                product = {"id": "PENDING"}
            products[name] = product
        existing_sizes = set()
        if product["id"] != "PENDING":
            existing_sizes = {s["size_label"] for s in sb.table("product_sizes").select("size_label").eq("product_id", product["id"]).execute().data}
        for order, (label, price) in enumerate(zip(SIZE_LABELS, prices)):
            if label in existing_sizes:
                continue
            new_sizes += 1
            if APPLY:
                sb.table("product_sizes").insert(
                    {"product_id": product["id"], "size_label": label, "price": price, "sort_order": order}
                ).execute()
        return product

    def get_or_create_ingredient(name: str, unit: str) -> str:
        nonlocal new_ingredients
        key = name.lower()
        if key in ingredients:
            return ingredients[key]
        print(f"    [NEW INGREDIENT] {name!r} (unit={unit})")
        new_ingredients += 1
        if APPLY:
            row = sb.table("ingredients").insert(
                {"name": name, "category": "Drip Tea", "base_unit": unit, "needs_review": False}
            ).execute().data[0]
            ingredients[key] = row["id"]
            return row["id"]
        ingredients[key] = "PENDING"
        return "PENDING"

    def write_recipe(product_size_ids: dict[str, str], drink_name: str, lines: list, inferred_note: str | None) -> None:
        nonlocal recipe_lines
        # Sum any genuinely-different-quantity duplicate ingredient names
        # (already pre-deduplicated for identical-quantity merged-cell
        # artifacts at transcription time -- see module docstring).
        summed: dict[str, list[float]] = {}
        for card_name, s, m, l in lines:
            vals = summed.setdefault(card_name, [0.0, 0.0, 0.0])
            vals[0] += s
            vals[1] += m
            vals[2] += l

        for size_label, size_id in product_size_ids.items():
            if APPLY:
                sb.table("recipe_items").delete().eq("product_size_id", size_id).execute()
        idx = {"Small": 0, "Medium": 1, "Large": 2}
        for card_name, qtys in summed.items():
            canon, unit = resolve(card_name)
            ing_id = get_or_create_ingredient(canon, unit)
            for size_label, size_id in product_size_ids.items():
                qty = qtys[idx[size_label]]
                recipe_lines += 1
                note = f"ESTIMATED by analogy to {inferred_note} -- not from a client-supplied card; confirm before relying on this for stock deduction." if inferred_note else None
                if APPLY:
                    real_ing_id = ing_id if ing_id != "PENDING" else ingredients[canon.lower()]
                    sb.table("recipe_items").insert(
                        {"product_size_id": size_id, "ingredient_id": real_ing_id, "qty_per_serving": qty,
                         "unit": unit, "needs_review": bool(inferred_note), "prep_notes": note}
                    ).execute()

    print("=" * 70)
    print("Products + sizes (all 29 SKUs)")
    print("=" * 70)
    all_products: dict[str, dict] = {}
    for series, info in SERIES_PRICING.items():
        for drink in info["drinks"]:
            active = drink not in NOT_AVAILABLE
            all_products[drink] = ensure_product(drink, f"Drip Tea ({series})", info["price"], active)
    for (series, drink), price in INDIVIDUAL_PRICING.items():
        active = drink not in NOT_AVAILABLE
        all_products[drink] = ensure_product(drink, f"Drip Tea ({series})", price, active)

    print("\n" + "=" * 70)
    print(f"Real recipes from the docx ({len(REAL_RECIPES)} drinks)")
    print("=" * 70)
    for drink, lines in REAL_RECIPES.items():
        print(f"\n{drink}:")
        product = all_products.get(drink)
        if not product or product["id"] == "PENDING":
            print("  (dry run -- product not yet created, recipe preview only)")
            for card_name, s, m, l in lines:
                canon, unit = resolve(card_name)
                print(f"  {canon}: S={s:g} M={m:g} L={l:g} {unit}")
            continue
        sizes = {s["size_label"]: s["id"] for s in sb.table("product_sizes").select("id,size_label").eq("product_id", product["id"]).execute().data}
        for card_name, s, m, l in lines:
            canon, unit = resolve(card_name)
            print(f"  {canon}: S={s:g} M={m:g} L={l:g} {unit}")
        write_recipe(sizes, drink, lines, None)

    print("\n" + "=" * 70)
    print(f"Inferred recipes (9 drinks with no card data -- ALL lines flagged needs_review)")
    print("=" * 70)
    for drink, (basis, lines) in INFERRED_RECIPES.items():
        print(f"\n{drink} (basis: {basis}):")
        product = all_products.get(drink)
        if not product or product["id"] == "PENDING":
            print("  (dry run -- product not yet created, recipe preview only)")
            for card_name, s, m, l in lines:
                canon, unit = resolve(card_name)
                print(f"  {canon}: S={s:g} M={m:g} L={l:g} {unit} [NEEDS_REVIEW]")
            continue
        sizes = {s["size_label"]: s["id"] for s in sb.table("product_sizes").select("id,size_label").eq("product_id", product["id"]).execute().data}
        for card_name, s, m, l in lines:
            canon, unit = resolve(card_name)
            print(f"  {canon}: S={s:g} M={m:g} L={l:g} {unit} [NEEDS_REVIEW]")
        write_recipe(sizes, drink, lines, basis)

    print("\n" + "=" * 70)
    print(f"SUMMARY -- {'APPLIED' if APPLY else 'DRY RUN (pass --apply to write)'}")
    print("=" * 70)
    print(f"Products: {new_products} new (of 29 total SKUs, 2 inactive/Not Available)")
    print(f"Sizes: {new_sizes}")
    print(f"New ingredients: {new_ingredients}")
    print(f"Recipe lines: {recipe_lines} (all {len(INFERRED_RECIPES)} inferred drinks fully flagged needs_review)")
    print("")
    print("NOT modeled: 'Ice' (given as a fill percentage on the card, not a")
    print("trackable weight/volume) -- deliberately excluded from recipe_items.")


if __name__ == "__main__":
    main()
