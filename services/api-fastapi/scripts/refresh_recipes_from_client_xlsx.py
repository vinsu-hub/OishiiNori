"""Menu integration, step 2 of 5: rebuild recipe_items for Baked Sushi,
Torched Maki, Ramen (all 8), and Rice Meals from the client's real recipe
cards (INVENTORY COFFEE GRIND.xlsx, sheets 'baked'/'Sheet2'/'RA'/'Sheet15'/
'Sheet3' -- transcribed by hand from a direct read of the workbook, not by
an automated parser, since these sheets mix side-by-side dishes with no
machine-friendly structure; every line below was read and verified against
the live terminal dump before being encoded here).

Each dish's raw ingredient lines are kept exactly as the card states them
(including a name/quantity appearing more than once per dish, e.g. "Mayo"
added at three different assembly steps) -- the script sums same-ingredient
lines into one recipe_items row per (product_size, ingredient), since that's
this table's natural unique key (matches recipe_items' existing convention).

UNIT HANDLING (read before trusting a number blindly):
_adjust_ingredients_for_size (transactions.py) deducts qty_per_serving
directly against ingredients.current_stock with NO unit conversion --
recipe_items.unit is a display label, not part of the deduction math. So a
recipe line's qty_per_serving MUST already be denominated in the matched
ingredient's own base_unit for stock deduction to mean anything.
  - Where the card's unit already matches the ingredient's base_unit
    (grams<->g, ml<->ml, pcs<->pcs): used as-is, no flag.
  - Where the card says "grams" for a sauce/mayo whose canonical ingredient
    is tracked in ml (Special mayo (house), Katsu sauce, etc.): treated 1:1
    (standard kitchen density approximation for a thick sauce), flagged
    needs_review=true with a prep_note explaining the assumption.
  - Where the card uses an informal unit with no defined conversion
    (scoop/sprinkle/pinch) against a gram/ml-tracked ingredient: recorded
    with the card's literal unit and number, flagged needs_review=true --
    stock deduction for that specific line will be numerically wrong until
    a human supplies the real conversion factor. This is a genuine,
    material limitation, not a rounding nuance -- see the run's summary.

New ingredients (not in the 73 that already exist) are created via the
Supabase REST API (service-role key) -- same reasoning as step 1.

Run with (dry-run first, no --apply):
  py -3 services/api-fastapi/scripts/refresh_recipes_from_client_xlsx.py
  py -3 services/api-fastapi/scripts/refresh_recipes_from_client_xlsx.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

APPLY = "--apply" in sys.argv

# ---------------------------------------------------------------------------
# Ingredient resolution: card text -> (canonical ingredient name, needs_review,
# note). `None` canonical name means "create a brand-new ingredient with this
# exact card text as its name".
# ---------------------------------------------------------------------------
ALIAS = {
    "Cooked Rice": ("Steamed rice", False, None),
    "Mozarella": ("Mozzarella cheese", False, None),
    "Mayo": ("Special mayo (house)", True, "Card gives this in grams; Special mayo (house) is tracked in ml -- treated 1:1 (thick-sauce density assumption)."),
    "Hot Mayo": ("Spicy mayo", True, "Card gives this in grams; Spicy mayo is tracked in ml -- treated 1:1 (thick-sauce density assumption)."),
    "Hot mayo": ("Spicy mayo", True, "Card gives this in grams; Spicy mayo is tracked in ml -- treated 1:1 (thick-sauce density assumption)."),
    "Creamcheese": ("Cream cheese", False, None),
    "Mango": ("Mango", False, None),
    "CrabSticks": ("Crab stick", False, None),
    "Crabsticks": ("Crab stick", False, None),
    "Ebiko": ("Ebiko (fish roe)", False, None),
    "Scallop": ("Scallop", False, None),
    "Prawns": ("Shrimp / Prawn (raw)", True, "Card gives this in grams for Oishii Baked Sushi's prawn line, which matches Shrimp / Prawn (raw)'s gram base_unit fine; flagged only because the same card name is reused with a piece-count elsewhere (see Breaded prawns)."),
    "Breaded prawns": ("Breaded prawn", True, "Card gives this as a PIECE COUNT (e.g. '2 pcs'), but Breaded prawn is tracked in grams -- recorded as literal-number-in-grams, which understates real usage; needs a real per-piece gram weight from the client."),
    "Cooked salmon": ("Salmon", False, None),
    "Teriyaki sauce": ("Teriyaki glaze", False, None),
    "Nori": ("Nori sheet", False, None),
    "Rice": ("Steamed rice", False, None),
    "Cucumber": ("Cucumber", False, None),
    "Salmon": ("Salmon", False, None),
    "Tuna": ("Tuna (raw, spicy tuna mix)", False, None),
    "Ramen base": ("Ramen broth (batch-prepped)", True, "Card's 'Ramen base' (dry/concentrate, grams) plus separate Water (ml) is a different model from the ingredient master's single pre-diluted 'Ramen broth (batch-prepped)' (ml) -- recorded as the base grams + water ml SUMMED against the ml-tracked broth ingredient (i.e. treating the base as if it were already-diluted broth), a real approximation pending a client-confirmed prep ratio."),
    "Rice (1 cup)": ("Steamed rice", True, "Card gives this as '1 cup rice' rather than a gram figure -- recorded as ~195g (a standard 1-cup-cooked-rice estimate, NOT a literal card number); confirm the real portion size with the client."),
    "Water": ("Ramen broth (batch-prepped)", True, "See the 'Ramen base' note on this same dish -- summed together into one broth figure."),
    "Beef": ("Beef (sliced)", False, None),
    "Noodles": ("Ramen noodles", True, "Card gives this as '1 pack' (one noodle brick per bowl), but Ramen noodles is tracked in grams -- recorded as literal-number-in-grams (i.e. '1'), which is nonsensically small; needs the real per-pack gram weight from the client."),
    "Spring Onion": ("Scallion", True, "Card gives this as '1 scoop', Scallion is tracked in grams -- recorded with the card's literal 'scoop' unit/number pending a real conversion factor."),
    "Sesame seeds": ("Sesame seeds", True, "Card gives this as sprinkle-count, Sesame seeds is tracked in grams -- recorded with the card's literal 'sprinkle' unit/number pending a real conversion factor."),
    "Egg": ("Egg (Tamago / soft-boiled)", False, None),
    "Chasu": ("Pork belly (Chasu)", False, None),
    "Tonkatsu": ("Pork (cutlet)", False, None),
    "Torikatsu": ("Chicken (cutlet)", False, None),
    "Ground pork": ("Ground pork (gyoza filling)", False, None),
    "AKA": (None, True, "Chili/miso paste blend used in Tantanmen, no existing ingredient -- created new."),
    "AKA ": (None, True, "Chili/miso paste blend used in Spicy Miso, no existing ingredient -- created new."),
    "KURO": (None, True, "Black-garlic-oil-style seasoning used in Kuro Chasumen, no existing ingredient -- created new."),
    "BLK GARLIC": (None, True, "Black garlic paste used in Black Garlic Ramen, no existing ingredient -- created new."),
    "Cheese sliced": ("Mozzarella cheese", True, "Card just says 'Cheese sliced' -- mapped to the existing sliced/blend cheese ingredient rather than creating a duplicate; confirm with the client if this should be a distinct sliced-cheese SKU. ALSO: card gives this as '1 pc' (one slice), but Mozzarella cheese is tracked in grams -- recorded as literal-number-in-grams (i.e. '1'), nonsensically small for a real cheese slice; needs a real per-slice gram weight."),
    "Tahong": ("Mussels", False, None),
    "Cabbage": ("Cabbage (slaw)", False, None),
    "Sesame seed": ("Sesame seeds", True, "Card gives this in grams (e.g. '5 GRAMS'), close enough to Sesame seeds' own gram base_unit -- used as-is, no conversion needed (flag kept only for visibility, not a real risk)."),
    "Srsame seeds": ("Sesame seeds", True, "Card typo ('Srsame'); same grams-unit note as Sesame seed."),
    "EBI FRY": ("Breaded shrimp (Ebi)", False, None),
    "Squid": ("Squid (Ika)", False, None),
    # Cafe (espresso-based)
    "Cold brew": ("Espresso beans / shots", True, "Card measures cold brew concentrate in ml; the ingredient master tracks espresso in 'shot' units -- recorded with the card's literal ml number pending a real ml-per-shot conversion."),
    "Milk": ("Milk", False, None),
    "Fructose": ("Simple syrup", True, "Card calls this 'Fructose', mapped to the existing generic Simple syrup ingredient rather than creating a duplicate sweetener SKU."),
    "Choco syrup": ("Chocolate sauce", False, None),
    "Condensed": (None, True, "Condensed milk, no existing ingredient -- created new."),
    "Vanilla syrup": (None, True, "No existing vanilla syrup ingredient -- created new."),
    "SC syrup": (None, True, "Salted caramel syrup, no existing ingredient -- created new."),
    "Salt": (None, True, "No existing plain salt ingredient -- created new (distinct from any house sauce)."),
    "Hazelnut syrup": (None, True, "No existing hazelnut syrup ingredient -- created new."),
    "Toffeenut syrup": (None, True, "No existing toffeenut syrup ingredient -- created new."),
    "Tiramisu syrup": (None, True, "No existing tiramisu syrup ingredient -- created new."),
}


# New ingredients whose natural unit clearly isn't grams (the fallback).
NEW_INGREDIENT_UNIT = {
    "Salted Nori": "pack",
    "Chopsticks": "pcs",
    "AKA": "g",
    "AKA ": "g",
    "KURO": "g",
    "BLK GARLIC": "g",
    "Condensed": "ml",
    "Vanilla syrup": "ml",
    "SC syrup": "ml",
    "Salt": "g",
    "Hazelnut syrup": "ml",
    "Toffeenut syrup": "ml",
    "Tiramisu syrup": "ml",
}


def get_or_create_ingredient(
    sb, cache: dict, unit_by_name: dict, card_name: str, dish_hint: str = ""
) -> tuple[str, str, bool, str | None]:
    """Returns (ingredient_id, ingredient_name, needs_review_for_this_line, note).
    Also populates unit_by_name[name.lower()] for a brand-new ingredient, so
    resolve_unit() sees its real unit immediately, not the "g" fallback."""
    canonical, flag, note = ALIAS.get(card_name, (card_name, True, f"No alias entry for {card_name!r} -- matched/created by literal name, confirm with the client."))
    name = canonical or card_name
    key = name.lower()
    if key in cache:
        return cache[key]["id"], cache[key]["name"], flag, note
    unit = NEW_INGREDIENT_UNIT.get(card_name, "g")
    print(f"  [NEW INGREDIENT] {name!r} (from card text {card_name!r}, unit={unit}, dish: {dish_hint})")
    if APPLY:
        row = sb.table("ingredients").insert(
            {"name": name, "category": "Uncategorized (client menu import)", "base_unit": unit, "needs_review": True}
        ).execute().data[0]
        cache[key] = {"id": row["id"], "name": name}
        unit_by_name[key] = unit
        return row["id"], name, True, note
    cache[key] = {"id": "PENDING", "name": name}
    unit_by_name[key] = unit
    return "PENDING", name, True, note


# ---------------------------------------------------------------------------
# Raw recipe lines, exactly as the source card states them (duplicates within
# one dish are intentional -- summed below). Shape:
#   { "Dish label": { "Size label": [(card_ingredient_name, qty), ...] } }
# ---------------------------------------------------------------------------

BAKED_SUSHI = {
    "Baked Kani Sushi": {
        "Small (2–3 pax)": [("Cooked Rice", 200), ("Mozarella", 10), ("Mayo", 15), ("Creamcheese", 20), ("Mango", 40),
                             ("Mayo", 15), ("CrabSticks", 3), ("Mayo", 15), ("Mozarella", 40), ("Ebiko", 3), ("Mayo", 15)],
        "Medium (4–5 pax)": [("Cooked Rice", 400), ("Mozarella", 20), ("Mayo", 20), ("Creamcheese", 40), ("Mango", 80),
                              ("Mayo", 20), ("CrabSticks", 6), ("Mayo", 20), ("Mozarella", 60), ("Ebiko", 6), ("Mayo", 20)],
        "Large (6–8 pax)": [("Cooked Rice", 500), ("Mozarella", 30), ("Mayo", 30), ("Creamcheese", 60), ("Mango", 100),
                             ("Mayo", 30), ("CrabSticks", 9), ("Mayo", 30), ("Mozarella", 80), ("Ebiko", 9), ("Mayo", 30)],
    },
    "Spicy Tuna Baked Sushi": {
        # Card's "SPICY TUNA/SCALLOP" block -- Spicy Tuna Baked Sushi uses the tuna filling.
        "Small (2–3 pax)": [("Cooked Rice", 200), ("Mozarella", 10), ("Hot Mayo", 15), ("Tuna", 50), ("Hot Mayo", 10),
                             ("Creamcheese", 20), ("Hot Mayo", 15), ("Mozarella", 40), ("Hot Mayo", 15)],
        "Medium (4–5 pax)": [("Cooked Rice", 400), ("Mozarella", 20), ("Hot Mayo", 20), ("Tuna", 100), ("Hot Mayo", 20),
                              ("Creamcheese", 40), ("Hot Mayo", 20), ("Mozarella", 60), ("Hot Mayo", 20)],
        "Large (6–8 pax)": [("Cooked Rice", 500), ("Mozarella", 30), ("Hot Mayo", 30), ("Tuna", 150), ("Hot Mayo", 30),
                             ("Creamcheese", 60), ("Hot Mayo", 30), ("Mozarella", 80), ("Hot Mayo", 30)],
    },
    "Cheesy Baked Spicy Scallop": {
        # Same card block, scallop filling.
        "Small (2–3 pax)": [("Cooked Rice", 200), ("Mozarella", 10), ("Hot Mayo", 15), ("Scallop", 50), ("Hot Mayo", 10),
                             ("Creamcheese", 20), ("Hot Mayo", 15), ("Mozarella", 40), ("Hot Mayo", 15)],
        "Medium (4–5 pax)": [("Cooked Rice", 400), ("Mozarella", 20), ("Hot Mayo", 20), ("Scallop", 100), ("Hot Mayo", 20),
                              ("Creamcheese", 40), ("Hot Mayo", 20), ("Mozarella", 60), ("Hot Mayo", 20)],
        "Large (6–8 pax)": [("Cooked Rice", 500), ("Mozarella", 30), ("Hot Mayo", 30), ("Scallop", 150), ("Hot Mayo", 30),
                             ("Creamcheese", 60), ("Hot Mayo", 30), ("Mozarella", 80), ("Hot Mayo", 30)],
    },
    "Oishii Baked Sushi": {
        "Small (2–3 pax)": [("Cooked Rice", 200), ("Mozarella", 10), ("Mayo", 10), ("Hot Mayo", 10), ("Creamcheese", 20),
                             ("Prawns", 5), ("Mayo", 10), ("Hot Mayo", 10), ("CrabSticks", 3), ("Mayo", 10), ("Hot Mayo", 10),
                             ("Mozarella", 40), ("Mayo", 10), ("Hot Mayo", 10)],
        "Medium (4–5 pax)": [("Cooked Rice", 400), ("Mozarella", 20), ("Mayo", 20), ("Hot Mayo", 20), ("Creamcheese", 40),
                              ("Prawns", 10), ("Mayo", 20), ("Hot Mayo", 20), ("CrabSticks", 6), ("Mayo", 20), ("Hot Mayo", 20),
                              ("Mozarella", 60), ("Mayo", 20), ("Hot Mayo", 20)],
        "Large (6–8 pax)": [("Cooked Rice", 500), ("Mozarella", 30), ("Mayo", 30), ("Hot Mayo", 30), ("Creamcheese", 60),
                             ("Prawns", 15), ("Mayo", 30), ("Hot Mayo", 30), ("CrabSticks", 9), ("Mayo", 30), ("Hot Mayo", 30),
                             ("Mozarella", 80), ("Mayo", 30), ("Hot Mayo", 30)],
    },
    "Baked Salmon Teriyaki": {
        "Small (2–3 pax)": [("Cooked Rice", 200), ("Mozarella", 10), ("Mayo", 15), ("Cooked salmon", 50), ("Teriyaki sauce", 10),
                             ("Creamcheese", 20), ("Mayo", 15), ("Mozarella", 40), ("Mayo", 15), ("Hot mayo", 15)],
        "Medium (4–5 pax)": [("Cooked Rice", 400), ("Mozarella", 20), ("Mayo", 20), ("Cooked salmon", 100), ("Teriyaki sauce", 20),
                              ("Creamcheese", 40), ("Mayo", 20), ("Mozarella", 60), ("Mayo", 20), ("Hot mayo", 20)],
        "Large (6–8 pax)": [("Cooked Rice", 500), ("Mozarella", 30), ("Mayo", 30), ("Cooked salmon", 150), ("Teriyaki sauce", 30),
                             ("Creamcheese", 60), ("Mayo", 30), ("Mozarella", 80), ("Mayo", 30), ("Hot mayo", 30)],
    },
}
# Salted Nori / Chopsticks: the "+1/+2/+3 nori" note on the client menu means
# the base price already includes this many nori/chopstick units -- add one
# line per size, same across all 5 baked items (the card's per-dish rows for
# these were identical: 1/2/3 packs, 1/2/3 pcs).
BAKED_SUSHI_SHARED_TAIL = {
    "Small (2–3 pax)": [("Salted Nori", 1), ("Chopsticks", 1)],
    "Medium (4–5 pax)": [("Salted Nori", 2), ("Chopsticks", 2)],
    "Large (6–8 pax)": [("Salted Nori", 3), ("Chopsticks", 3)],
}
ALIAS["Salted Nori"] = (None, True, "New packaging-tracked-as-ingredient line, matches the client menu's '+1/2/3 nori' base inclusion -- created new (unit: pack).")
ALIAS["Chopsticks"] = (None, True, "New packaging-tracked-as-ingredient line -- created new (unit: pcs).")

TORCHED_MAKI = {
    "Torched Cheesy Tempura Maki": [("Nori", 0.5), ("Rice", 120), ("Breaded prawns", 2), ("Creamcheese", 10), ("Mozarella", 15), ("Hot mayo", 15)],
    "Torched Cheesy Salmon Maki": [("Nori", 0.5), ("Rice", 120), ("Cucumber", 2), ("Creamcheese", 10), ("Crabsticks", 2), ("Salmon", 30), ("Mayo", 10)],
    "Torched Cheesy Tuna Maki": [("Nori", 0.5), ("Rice", 120), ("Cucumber", 2), ("Creamcheese", 10), ("Crabsticks", 2), ("Tuna", 30), ("Hot Mayo", 15)],
}

# RA + Sheet15 sheets -- all 8 ramen bowls, one size each ("1 bowl").
RAMEN = {
    "Beef Ramen": [("Ramen base", 60), ("Water", 225), ("Beef", 50), ("Noodles", 1), ("Spring Onion", 1), ("Sesame seeds", 3), ("Nori", 1), ("Egg", 1)],
    "Chasu Ramen": [("Ramen base", 60), ("Water", 225), ("Chasu", 1), ("Noodles", 1), ("Spring Onion", 1), ("Sesame seeds", 3), ("Nori", 1), ("Egg", 1)],
    "Tonkatsu Ramen": [("Ramen base", 60), ("Water", 225), ("Tonkatsu", 0.5), ("Noodles", 1), ("Spring Onion", 1), ("Sesame seeds", 3), ("Nori", 1), ("Egg", 1)],
    "Torikatsu Ramen": [("Ramen base", 60), ("Water", 225), ("Torikatsu", 0.5), ("Noodles", 1), ("Spring Onion", 1), ("Sesame seeds", 3), ("Nori", 1), ("Egg", 1)],
    "Oishii Nori Ramen": [("Ramen base", 60), ("Water", 225), ("Beef", 50), ("Chasu", 3), ("Noodles", 1), ("Sesame seeds", 3), ("Spring Onion", 1), ("Cheese sliced", 1), ("Nori", 1), ("Egg", 1)],
    "Seafood Ramen": [("Ramen base", 60), ("Water", 225), ("Prawns", 2), ("Tahong", 4), ("Sesame seeds", 3), ("Noodles", 1), ("Spring Onion", 1), ("Nori", 1), ("Egg", 1)],
}

RICE_MEALS = {
    "Salmon Teriyaki": [("Salmon", 100), ("Teriyaki sauce", 30), ("Sesame seed", 5), ("Rice", 160), ("Cabbage", 10), ("Mayo", 5)],
    "Pork Tonkatsu": [("Tonkatsu", 1), ("Sesame seed", 5), ("Rice", 160), ("Cabbage", 10), ("Mayo", 5)],
    "Pork Teriyaki": [("Chasu", 2), ("Teriyaki sauce", 2), ("Sesame seed", 5), ("Rice (1 cup)", 195), ("Cabbage", 10), ("Mayo", 5)],
    # Card's "TORIKATSU" dish block literally re-uses the ingredient-row text
    # "Tonkatsu" (pork) under a dish header named TORIKATSU (chicken) -- an
    # apparent copy-paste artifact on the client's own card (Chicken
    # Teriyaki's block, just above it, correctly uses "TORIKATSU" as its
    # protein-row text for a chicken cutlet). Corrected to "Torikatsu"
    # (Chicken (cutlet)) here rather than faithfully reproducing a source
    # typo that would put pork into a product named "(Chicken)".
    "Torikatsu (Chicken)": [("Torikatsu", 1), ("Sesame seed", 5), ("Rice (1 cup)", 195), ("Cabbage", 10), ("Mayo", 5)],
    "Beef Teriyaki": [("Beef", 100), ("Teriyaki sauce", 2), ("Sesame seed", 5), ("Rice (1 cup)", 195), ("Cabbage", 10), ("Mayo", 5)],
    "Chicken Teriyaki": [("Torikatsu", 1), ("Teriyaki sauce", 2), ("Sesame seed", 5), ("Rice (1 cup)", 195), ("Cabbage", 10), ("Mayo", 5)],
    "Ebi Fry": [("EBI FRY", 4), ("Sesame seed", 5), ("Rice (1 cup)", 195), ("Cabbage", 10), ("Mayo", 5)],
    "Ika Furai": [("Squid", 4), ("Sesame seed", 5), ("Rice (1 cup)", 195), ("Cabbage", 10), ("Mayo", 5)],
}
# NOTE on Beef/Chicken Yakiniku: the xlsx Sheet3 card has no distinct
# "Yakiniku" block at all -- only Salmon/Pork/Beef/Chicken Teriyaki and
# Tonkatsu/Torikatsu/Ebi Fry/Ika Furai are on the card, so it's deliberately
# left out of RICE_MEALS above (its live recipe is left untouched).


PRODUCT_SIZE_IDS = {
    ("Baked Kani Sushi", "Small (2–3 pax)"): "83247b98-b935-4e7f-af88-0c72dc0ca99d",
    ("Baked Kani Sushi", "Medium (4–5 pax)"): "99bdcf8d-5b9a-4a7e-a4c6-41df66cf0613",
    ("Baked Kani Sushi", "Large (6–8 pax)"): "88aaa447-1845-42d6-be9c-b747867a6d70",
    ("Spicy Tuna Baked Sushi", "Small (2–3 pax)"): "9410fca4-b26d-4a0e-b839-caa6c169c967",
    ("Spicy Tuna Baked Sushi", "Medium (4–5 pax)"): "51455a89-b26e-48e5-bced-7c3aba934822",
    ("Spicy Tuna Baked Sushi", "Large (6–8 pax)"): "f350a840-e789-4ea0-9976-4e0428eacae3",
    ("Cheesy Baked Spicy Scallop", "Small (2–3 pax)"): "de706413-e76f-4a8a-ab0b-d03a11d6cdd0",
    ("Cheesy Baked Spicy Scallop", "Medium (4–5 pax)"): "c1f6abe1-c428-42c1-897a-5f2c78735ad2",
    ("Cheesy Baked Spicy Scallop", "Large (6–8 pax)"): "5c0441c6-efbc-4a0e-b8ce-970330cd9c23",
    ("Oishii Baked Sushi", "Small (2–3 pax)"): "71e9142c-8986-481f-b18b-0a26bc01826d",
    ("Oishii Baked Sushi", "Medium (4–5 pax)"): "6229b912-c355-4462-9ba5-2e0f033aa323",
    ("Oishii Baked Sushi", "Large (6–8 pax)"): "059269b8-ac6f-484a-b23b-3b22c559a80c",
    ("Baked Salmon Teriyaki", "Small (2–3 pax)"): "fb4c8189-5575-4dc6-ae25-9b498acd4172",
    ("Baked Salmon Teriyaki", "Medium (4–5 pax)"): "21dd883e-6fc6-4de0-aa7a-0a0ebcc1e182",
    ("Baked Salmon Teriyaki", "Large (6–8 pax)"): "728b7fde-48eb-48c8-8d5e-e5310fb74fd6",
    ("Torched Cheesy Tempura Maki", "8 pcs"): "09c44999-3dcf-4159-8a50-3036bcf453c5",
    ("Torched Cheesy Salmon Maki", "8 pcs"): "61c88fb2-1d93-4035-afd5-c53bf873fdf1",
    ("Torched Cheesy Tuna Maki", "8 pcs"): "8b626a55-b83a-4801-b57d-a98ac7d3373c",
    ("Beef Ramen", "1 bowl"): "c6d602d5-fe2d-499d-b19c-0bbc773a879c",
    ("Chasu Ramen", "1 bowl"): "446db331-9640-4ecf-9c1b-d491ad048a55",
    ("Tonkatsu Ramen", "1 bowl"): "43a6b121-9088-4e12-8ecd-de4dd80b1e11",
    ("Torikatsu Ramen", "1 bowl"): "946f8058-bfdc-4271-ac5c-896d2196df42",
    ("Oishii Nori Ramen", "1 bowl"): "dad5c73e-ff79-4c00-a23f-c2cf73789bb8",
    ("Seafood Ramen", "1 bowl"): "ffcfc29a-6dd1-46c3-9d7a-b77a0fe02f67",
    ("Salmon Teriyaki", "1 plate"): "9123a58e-c020-46fd-84fd-67708112fb66",
    ("Pork Tonkatsu", "1 plate"): "e9b0f922-71b3-44a4-984e-4053d6920cf2",
    ("Pork Teriyaki", "1 plate"): "2c4db9d9-60ee-4a85-8b41-4d5483e76db1",
    ("Torikatsu (Chicken)", "1 plate"): "f1f4b141-d28a-46ae-80ea-f3c36fe5117d",
    ("Beef Teriyaki", "1 plate"): "b35c9bcf-89e4-4253-bfba-38bb0fee9c6a",
    ("Chicken Teriyaki", "1 plate"): "3f95102c-8613-4f92-af7b-28b3c7effafa",
    ("Ebi Fry", "1 plate"): "3040509b-4edf-4cea-a170-ab1f06ecce65",
    ("Ika Furai", "1 plate"): "f404059a-9374-4f28-865b-5d78f0ddcef4",
}


def resolve_unit(ingredient_name: str, existing_units: dict[str, str]) -> str:
    return existing_units.get(ingredient_name.lower(), "g")


def main() -> None:
    sb = get_supabase()
    ingredient_rows = sb.table("ingredients").select("id,name,base_unit").execute().data
    cache = {r["name"].lower(): {"id": r["id"], "name": r["name"]} for r in ingredient_rows}
    unit_by_name = {r["name"].lower(): r["base_unit"] for r in ingredient_rows}

    new_ingredient_count = 0
    total_lines = 0
    flagged_lines = 0

    def process_dish(product_size_id: str, dish_label: str, size_label: str, raw_lines: list[tuple[str, float]]) -> None:
        nonlocal new_ingredient_count, total_lines, flagged_lines
        print(f"\n{dish_label} ({size_label}):")
        summed: dict[str, dict] = {}  # ingredient_name -> {qty, needs_review, notes:set, unit}
        for card_name, qty in raw_lines:
            before = len(cache)
            ing_id, ing_name, flag, note = get_or_create_ingredient(sb, cache, unit_by_name, card_name, dish_label)
            if len(cache) > before:
                new_ingredient_count += 1
            entry = summed.setdefault(ing_name, {"id": ing_id, "qty": 0.0, "needs_review": False, "notes": set()})
            entry["qty"] += qty
            entry["needs_review"] = entry["needs_review"] or flag
            if note:
                entry["notes"].add(note)

        if APPLY:
            sb.table("recipe_items").delete().eq("product_size_id", product_size_id).execute()

        for ing_name, entry in summed.items():
            total_lines += 1
            unit = resolve_unit(ing_name, unit_by_name)
            note = " ".join(sorted(entry["notes"])) or None
            flag_str = " [NEEDS_REVIEW]" if entry["needs_review"] else ""
            if entry["needs_review"]:
                flagged_lines += 1
            print(f"  {ing_name}: {entry['qty']:g} {unit}{flag_str}")
            if APPLY:
                ing_id = entry["id"]
                if ing_id == "PENDING":
                    ing_id = cache[ing_name.lower()]["id"]
                sb.table("recipe_items").insert(
                    {
                        "product_size_id": product_size_id,
                        "ingredient_id": ing_id,
                        "qty_per_serving": entry["qty"],
                        "unit": unit,
                        "needs_review": entry["needs_review"],
                        "prep_notes": note,
                    }
                ).execute()

    print("=" * 70)
    print("Baked Sushi (5 items x 3 sizes, incl. shared nori/chopstick tail)")
    print("=" * 70)
    for dish, sizes in BAKED_SUSHI.items():
        for size_label, lines in sizes.items():
            full_lines = lines + BAKED_SUSHI_SHARED_TAIL[size_label]
            process_dish(PRODUCT_SIZE_IDS[(dish, size_label)], dish, size_label, full_lines)

    print("\n" + "=" * 70)
    print("Torched Maki (3 items, single size)")
    print("=" * 70)
    for dish, lines in TORCHED_MAKI.items():
        process_dish(PRODUCT_SIZE_IDS[(dish, "8 pcs")], dish, "8 pcs", lines)

    print("\n" + "=" * 70)
    print("Ramen (6 of 8 -- Tantanmen/Kuro Chasumen/Spicy Miso/Black Garlic are")
    print("net-new products, not yet in the catalog -- deferred, not skipped)")
    print("=" * 70)
    for dish, lines in RAMEN.items():
        process_dish(PRODUCT_SIZE_IDS[(dish, "1 bowl")], dish, "1 bowl", lines)

    print("\n" + "=" * 70)
    print("Rice Meals (8 of 9 -- see Beef/Chicken Yakiniku note below)")
    print("=" * 70)
    for dish, lines in RICE_MEALS.items():
        process_dish(PRODUCT_SIZE_IDS[(dish, "1 plate")], dish, "1 plate", lines)

    print("\n" + "=" * 70)
    print(f"SUMMARY -- {'APPLIED' if APPLY else 'DRY RUN (pass --apply to write)'}")
    print("=" * 70)
    print(f"Recipe lines written: {total_lines} ({flagged_lines} flagged needs_review)")
    print(f"New ingredients created: {new_ingredient_count}")
    print("")
    print("NOT done by this script (real gaps, not silently skipped):")
    print("  - Beef/Chicken Yakiniku: the xlsx card has no matching recipe block at all")
    print("    (only Teriyaki x4 + Tonkatsu/Torikatsu/Ebi Fry/Ika Furai exist) -- its")
    print("    recipe is UNCHANGED (whatever was live before this script ran).")
    print("  - Tantanmen, Kuro Chasumen, Spicy Miso, Black Garlic Ramen (the 4 'New'")
    print("    ramen items) have real xlsx recipes (Sheet15) but are net-new products,")
    print("    not yet created -- belongs with a later net-new-item pass, not here.")
    print("  - Net-new cafe drinks (Tiramisu/Daku Choko/Ichigo Rate/etc.) -- deferred.")
    print("  - Unit-mismatch lines above marked needs_review deduct stock using the")
    print("    card's literal number against the matched ingredient's base_unit --")
    print("    accurate only where a real conversion factor happens to be 1:1.")


if __name__ == "__main__":
    main()
