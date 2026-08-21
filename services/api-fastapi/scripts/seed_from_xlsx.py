"""
Seed the Oishii Nori Command Suite Phase 1 schema from the client's menu
spreadsheet (D:\\ioshinori\\Oishii_Nori_Menu_Ingredients.xlsx).

Populates, in order: ingredients, products, product_sizes, recipe_items,
bundle_components. Idempotent — safe to re-run; every insert is an
upsert keyed on the table's natural unique constraint.

Run with:  py -3 services/api-fastapi/scripts/seed_from_xlsx.py

Connects directly to Postgres (not via the Supabase REST API) using
SUPABASE_DB_PASSWORD from services/api-fastapi/.env.local, so it can see
tables regardless of PostgREST "exposed schemas" settings. Only touches
`public` schema tables — this script does not seed HR/payroll data.

--------------------------------------------------------------------------
INGREDIENT NAME ALIASING — read this before touching ALIAS_MAP
--------------------------------------------------------------------------
The "Menu & Recipes" sheet's Ingredient column uses casual, per-recipe
phrasing ("Salmon (raw/seared)", "Mayo", "Sushi rice (cooked)") that does
NOT literally match the canonical names in the "Ingredient Master" sheet
("Salmon", "Special mayo (house)", "Sushi rice (raw)"). Verified: of 88
distinct ingredient-name strings used across the 60 (product, size) recipe
rows, only 46 match an Ingredient Master name exactly; ALIAS_MAP resolves
the other 42 to a canonical Ingredient Master row, chosen from used_in
text / prep notes / units for context. One name ("Water", used only in
Amerikano to dilute espresso) has no reasonable canonical match at all —
it is inserted as a genuinely new 73rd ingredient row, flagged
needs_review=true, since Ingredient Master has no row for it. This
resolution was NOT specified by the task and is a judgment call — see the
final report for the full list of ambiguous cases (e.g. "Special sauce"
used across 5 different rolls all map to 'Special mayo (house)').
"""
import json
import os
import re
import sys
from collections import defaultdict

import openpyxl
import psycopg2
import psycopg2.extras

XLSX_PATH = r"D:\ioshinori\Oishii_Nori_Menu_Ingredients.xlsx"
ENV_LOCAL_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")

# ---------------------------------------------------------------------------
# Ingredient name aliasing: recipe-sheet text -> canonical Ingredient Master
# name. See module docstring.
# ---------------------------------------------------------------------------
ALIAS_MAP = {
    "Sushi rice (cooked)": "Sushi rice (raw)",
    "Special mayo": "Special mayo (house)",
    "Crispy kani (garnish)": "Crispy kani (garnish, batch-prepped)",
    "Salmon (raw/seared)": "Salmon",
    "Cheese (mozzarella blend)": "Mozzarella cheese",
    "Spicy tuna mix": "Tuna (raw, spicy tuna mix)",
    # AMBIGUOUS: "Special sauce" appears on Spicy Tuna Roll, Kani Salad,
    # Torikatsu Maki, Dragon Maki, Oishii Maki — all mapped to the generic
    # house mayo/sauce rather than Katsu sauce or Spicy mayo, since those
    # are used elsewhere under their own explicit names. Flag for client
    # confirmation.
    "Special sauce": "Special mayo (house)",
    "Oishii salad sauce": "Oishii salad sauce (house)",
    "Mayo": "Special mayo (house)",
    "Prawns": "Shrimp / Prawn (raw)",
    "Mozzarella cheese blend": "Cheese blend (torching)",
    "Bibigo seasoned seaweed": "Bibigo seasoned seaweed (branded SKU)",
    "Sliced beef": "Beef (sliced)",
    "Soft-boiled egg": "Egg (Tamago / soft-boiled)",
    "Scallion (chopped)": "Scallion",
    "Fried pork cutlet": "Pork (cutlet)",
    "Chasu (braised pork belly, sliced)": "Pork belly (Chasu)",
    "Fried chicken cutlet": "Chicken (cutlet)",
    "Shrimp": "Shrimp / Prawn (raw)",
    "Angus beef, sliced": "Angus beef (sliced)",
    "Espresso shot": "Espresso beans / shots",
    "Pastillas syrup": "Pastillas syrup (house)",
    "Sea salt cream foam": "Sea salt cream foam (house)",
    "Pistachio mousse cream": "Pistachio mousse cream (house)",
    "Breaded pork cutlet": "Pork (cutlet)",
    "Mozzarella/cheese slices": "Mozzarella cheese",
    "Cabbage slaw": "Cabbage (slaw)",
    "Katsu/special dark sauce": "Katsu sauce",
    "Tamago (egg)": "Egg (Tamago / soft-boiled)",
    "Ebiko": "Ebiko (fish roe)",
    "Breaded chicken": "Chicken (cutlet)",
    "Kani salad mix": "Crab stick",
    "Gyoza filling (pork & veg)": "Ground pork (gyoza filling)",
    "Breaded chicken cutlet": "Chicken (cutlet)",
    "Salmon fillet": "Salmon",
    "Pork (sliced)": "Pork (sliced, teriyaki)",
    "Breaded squid rings": "Squid (Ika)",
    "Breaded shrimp": "Breaded shrimp (Ebi)",
    # AMBIGUOUS: Beef/Chicken Yakiniku recipe genuinely allows either
    # protein; mapped to Beef (sliced) as the primary/first-listed option.
    "Beef or chicken (sliced)": "Beef (sliced)",
    "Chicken (sliced)": "Chicken (sliced, teriyaki)",
    "Carrots (julienne)": "Carrot",
}

# Recipe-sheet ingredient names with no Ingredient Master row at all.
# Inserted as new ingredient rows (needs_review=true).
NEW_INGREDIENTS = {
    "Water": {
        "category": "Cafe/Beverage",
        "base_unit": "ml",
        "suggested_reorder_unit": None,
        "cost_volatility": None,
        "shelf_life_note": None,
        "used_in_note": "Amerikano (dilution)",
    },
}

# Placeholder ingredient text used on bundle rows to point at the Bundles &
# Platters sheet instead of a real ingredient consumption line. Excluded
# from recipe_items; the same row's info feeds bundle_components instead.
BUNDLE_PLACEHOLDER_INGREDIENT = "(See Bundles & Platters tab)"

# Kitchen station text (Menu & Recipes "Station" column) -> enum value.
STATION_MAP = {
    "Sushi Bar": "sushi_bar",
    "Sushi Bar / Oven": "sushi_bar_oven",
    "Hot Line": "hot_line",
    "Salad/Cold Bar": "salad_cold_bar",
    "Cafe Bar": "cafe_bar",
}

# Ingredient Master "Cost Volatility" raw string -> normalized 5-bucket tier.
VOLATILITY_TIER_MAP = {
    "High": "high",
    "High — daily price check": "high",
    "Medium–High": "medium_high",
    "Medium": "medium",
    "Medium — seasonal": "medium",
    "Medium — commodity pricing": "medium",
    "Low–Medium": "low_medium",
    "Low–Medium (protein bones)": "low_medium",
    "Low–Medium — commodity pricing": "low_medium",
    "Low": "low",
}


def load_env_local(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def get_db_connection():
    env = load_env_local(ENV_LOCAL_PATH)
    supabase_url = env["SUPABASE_URL"]  # https://<ref>.supabase.co
    password = env["SUPABASE_DB_PASSWORD"]
    ref = re.match(r"https://([a-z0-9]+)\.supabase\.co", supabase_url).group(1)
    host = f"db.{ref}.supabase.co"
    return psycopg2.connect(
        host=host, port=5432, user="postgres", password=password,
        dbname="postgres", sslmode="require",
    )


# ---------------------------------------------------------------------------
# XLSX extraction (same logic as the verification script)
# ---------------------------------------------------------------------------
def extract_menu_recipes(ws):
    products = []
    current = None
    for r in ws.iter_rows(min_row=4, values_only=True):
        cat, item, size, price, station, ingredient, qty, unit, notes, needs_review = (list(r) + [None] * 10)[:10]
        if item:
            current = {
                "category": cat, "item": item, "size": size, "price": price,
                "station": station, "ingredients": [],
            }
            products.append(current)
        if ingredient and current is not None:
            nr = bool(needs_review) and str(needs_review).strip() != ""
            current["ingredients"].append({
                "ingredient": ingredient, "qty": qty, "unit": unit,
                "prep_notes": notes, "needs_review": nr,
            })
    return products


def extract_bundles(ws):
    bundles = []
    for row in ws.iter_rows(min_row=4, values_only=True):
        bundle_item, bundle_size, total_pieces, draws_from, alloc_method, notes = (list(row) + [None] * 6)[:6]
        if bundle_item is None:
            continue
        bundles.append({
            "bundle_item": bundle_item, "bundle_size": bundle_size,
            "total_pieces": total_pieces, "draws_from": draws_from,
            "allocation_method": alloc_method, "notes": notes,
        })
    return bundles


def extract_ingredient_master(ws):
    ingredients = []
    for row in ws.iter_rows(min_row=4, values_only=True):
        name, category, base_unit, reorder_unit, volatility, shelf_life, used_in = (list(row) + [None] * 7)[:7]
        if name is None:
            continue
        ingredients.append({
            "name": name, "category": category, "base_unit": base_unit,
            "suggested_reorder_unit": reorder_unit, "cost_volatility": volatility,
            "shelf_life_note": shelf_life, "used_in_note": used_in,
        })
    return ingredients


def resolve_ingredient_name(raw_name):
    """Return the canonical Ingredient Master name for a recipe-sheet
    ingredient string, applying ALIAS_MAP where needed."""
    return ALIAS_MAP.get(raw_name, raw_name)


def compute_scale_factors(tiers):
    """tiers: list of dicts (already sorted Small->Large) each with
    'ingredients' = list of {ingredient, qty}. Returns list of scale_factor
    floats aligned to `tiers`, relative to tiers[0] (base = 1.0)."""
    if len(tiers) <= 1:
        return [1.0] * len(tiers)
    base_map = {
        i["ingredient"]: i["qty"] for i in tiers[0]["ingredients"]
        if isinstance(i["qty"], (int, float))
    }
    factors = [1.0]
    for t in tiers[1:]:
        ratios = []
        for i in t["ingredients"]:
            q = i["qty"]
            bq = base_map.get(i["ingredient"])
            if isinstance(q, (int, float)) and isinstance(bq, (int, float)) and bq:
                ratios.append(q / bq)
        ratios.sort()
        factors.append(round(ratios[len(ratios) // 2], 4) if ratios else 1.0)
    return factors


def main():
    print(f"Reading {XLSX_PATH} ...")
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)
    menu_products = extract_menu_recipes(wb["Menu & Recipes"])
    bundles = extract_bundles(wb["Bundles & Platters"])
    ingredient_master = extract_ingredient_master(wb["Ingredient Master"])

    print(f"  {len(menu_products)} (product,size) rows, "
          f"{len(set(p['item'] for p in menu_products))} distinct products")
    print(f"  {len(bundles)} bundle rows, {len(ingredient_master)} ingredient master rows")

    conn = get_db_connection()
    conn.autocommit = False
    cur = conn.cursor()

    try:
        # -------------------------------------------------------------
        # 1) ingredients (Ingredient Master, 72 rows + new-ingredient rows)
        # -------------------------------------------------------------
        ingredient_ids = {}  # name -> id
        for ing in ingredient_master:
            tier = VOLATILITY_TIER_MAP.get(ing["cost_volatility"])
            cur.execute(
                """
                insert into ingredients
                    (name, category, base_unit, suggested_reorder_unit,
                     cost_volatility, cost_volatility_tier, shelf_life_note,
                     used_in_note, needs_review)
                values (%s, %s, %s, %s, %s, %s, %s, %s, false)
                on conflict (name) do update set
                    category = excluded.category,
                    base_unit = excluded.base_unit,
                    suggested_reorder_unit = excluded.suggested_reorder_unit,
                    cost_volatility = excluded.cost_volatility,
                    cost_volatility_tier = excluded.cost_volatility_tier,
                    shelf_life_note = excluded.shelf_life_note,
                    used_in_note = excluded.used_in_note,
                    updated_at = now()
                returning id
                """,
                (ing["name"], ing["category"], ing["base_unit"],
                 ing["suggested_reorder_unit"], ing["cost_volatility"], tier,
                 ing["shelf_life_note"], ing["used_in_note"]),
            )
            ingredient_ids[ing["name"]] = cur.fetchone()[0]

        for name, extra in NEW_INGREDIENTS.items():
            cur.execute(
                """
                insert into ingredients
                    (name, category, base_unit, suggested_reorder_unit,
                     cost_volatility, cost_volatility_tier, shelf_life_note,
                     used_in_note, needs_review)
                values (%s, %s, %s, %s, %s, %s, %s, %s, true)
                on conflict (name) do update set
                    category = excluded.category,
                    base_unit = excluded.base_unit,
                    used_in_note = excluded.used_in_note,
                    updated_at = now()
                returning id
                """,
                (name, extra["category"], extra["base_unit"],
                 extra["suggested_reorder_unit"], extra["cost_volatility"],
                 None, extra["shelf_life_note"], extra["used_in_note"]),
            )
            ingredient_ids[name] = cur.fetchone()[0]

        print(f"Upserted {len(ingredient_ids)} ingredients "
              f"({len(ingredient_master)} from Ingredient Master + {len(NEW_INGREDIENTS)} new)")

        # -------------------------------------------------------------
        # 2) products + product_sizes
        # -------------------------------------------------------------
        by_item = defaultdict(list)
        for p in menu_products:
            by_item[p["item"]].append(p)

        product_ids = {}       # item name -> product id
        product_size_ids = {}  # (item name, size label) -> product_size id
        recipe_rows_by_product_size = {}  # (item, size) -> list of ingredient rows

        for item_name, tiers in by_item.items():
            first = tiers[0]
            category = first["category"]
            station_raw = first["station"]
            station_enum = STATION_MAP[station_raw]
            department = "cafe" if station_enum == "cafe_bar" else "kitchen"
            is_bundle = "Bundle" in (category or "")

            cur.execute(
                """
                insert into products (name, category, station, department, is_bundle)
                values (%s, %s, %s, %s, %s)
                on conflict (name) do update set
                    category = excluded.category,
                    station = excluded.station,
                    department = excluded.department,
                    is_bundle = excluded.is_bundle,
                    updated_at = now()
                returning id
                """,
                (item_name, category, station_enum, department, is_bundle),
            )
            product_id = cur.fetchone()[0]
            product_ids[item_name] = product_id

            factors = compute_scale_factors(tiers)
            for idx, t in enumerate(tiers):
                cur.execute(
                    """
                    insert into product_sizes (product_id, size_label, price, scale_factor, sort_order)
                    values (%s, %s, %s, %s, %s)
                    on conflict (product_id, size_label) do update set
                        price = excluded.price,
                        scale_factor = excluded.scale_factor,
                        sort_order = excluded.sort_order
                    returning id
                    """,
                    (product_id, t["size"], t["price"], factors[idx], idx),
                )
                ps_id = cur.fetchone()[0]
                product_size_ids[(item_name, t["size"])] = ps_id
                recipe_rows_by_product_size[(item_name, t["size"])] = t["ingredients"]

        print(f"Upserted {len(product_ids)} products, {len(product_size_ids)} product_sizes")

        # -------------------------------------------------------------
        # 3) recipe_items (real ingredient lines only — excludes the 5
        #    bundle placeholder rows, which carry no numeric quantity and
        #    instead feed bundle_components below)
        # -------------------------------------------------------------
        recipe_item_count = 0
        needs_review_count = 0
        skipped_bundle_placeholders = 0
        unresolved = set()

        for (item_name, size_label), ing_rows in recipe_rows_by_product_size.items():
            ps_id = product_size_ids[(item_name, size_label)]
            for row in ing_rows:
                if row["ingredient"] == BUNDLE_PLACEHOLDER_INGREDIENT:
                    skipped_bundle_placeholders += 1
                    continue
                canonical = resolve_ingredient_name(row["ingredient"])
                ing_id = ingredient_ids.get(canonical)
                if ing_id is None:
                    unresolved.add(row["ingredient"])
                    continue
                cur.execute(
                    """
                    insert into recipe_items
                        (product_size_id, ingredient_id, qty_per_serving, unit, prep_notes, needs_review)
                    values (%s, %s, %s, %s, %s, %s)
                    on conflict (product_size_id, ingredient_id) do update set
                        qty_per_serving = excluded.qty_per_serving,
                        unit = excluded.unit,
                        prep_notes = excluded.prep_notes,
                        needs_review = excluded.needs_review
                    """,
                    (ps_id, ing_id, row["qty"], row["unit"], row["prep_notes"], row["needs_review"]),
                )
                recipe_item_count += 1
                if row["needs_review"]:
                    needs_review_count += 1

        if unresolved:
            print(f"WARNING: {len(unresolved)} ingredient names could not be resolved: {sorted(unresolved)}")

        print(f"Upserted {recipe_item_count} recipe_items ({needs_review_count} needs_review=true); "
              f"skipped {skipped_bundle_placeholders} bundle placeholder lines (-> bundle_components instead)")

        # -------------------------------------------------------------
        # 4) bundle_components (from "Bundles & Platters" sheet, matched
        #    to the bundle's product_size by (item name, size label))
        # -------------------------------------------------------------
        bundle_count = 0
        for b in bundles:
            key = (b["bundle_item"], b["bundle_size"])
            ps_id = product_size_ids.get(key)
            if ps_id is None:
                print(f"WARNING: bundle row {key!r} has no matching product_size — skipped")
                continue
            cur.execute(
                """
                insert into bundle_components
                    (product_size_id, draws_from, total_pieces, allocation_method, notes)
                values (%s, %s, %s, %s, %s)
                on conflict (product_size_id) do update set
                    draws_from = excluded.draws_from,
                    total_pieces = excluded.total_pieces,
                    allocation_method = excluded.allocation_method,
                    notes = excluded.notes
                """,
                (ps_id, b["draws_from"], b["total_pieces"], b["allocation_method"], b["notes"]),
            )
            bundle_count += 1

        print(f"Upserted {bundle_count} bundle_components")

        conn.commit()
        print("COMMITTED.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
