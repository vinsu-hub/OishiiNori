"""Sir Joe's per-station count units, the linked rice chain and the missing
prep bases (2026-11-20).

Needs migration 0088 (change_item_base_unit) for the unit changes, and the
prep-bases API that allows a base made from another base.

0. Rice names, Sir Joe's way:
     Sushi rice (raw) -> Japanese rice raw
     Steamed rice     -> Japanese rice cooked (rice meals)
     new              -> Japanese sushi rice cooked (cooked rice + vinegar, maki)
1. Main unit changes, converted with change_item_base_unit:
   - Drip Tea powders: scoop -> g (their "kg = 40 scoop" size: 1 scoop = 25 g).
   - Nutella: stirrer -> g (1 stirrer = 10 g).
   - Cocoa / Creamer: scoop -> g (1 scoop = 15 g). Today's count of 1000 was
     grams, so stock is set back to 1000 g right after.
   - Pearl (tapioca), cooked: scoop -> g (1 scoop = 30 g).
   - J Rice cooked, Aka, Kuro, Tantan: pcs -> g (1 pc = 120 g), grams only.
   - Spoon, Fork: pcs -> g (1 pc = 5 g), pcs kept as a size.
   - Fries kg -> g; Straw, Thin straw pack -> pcs (100); Tako Crabstick
     pack -> pcs (30 sticks x 6 = 180); Tako mix pack -> g (1000).
   - Label-only fixes while stock is 0: Wasabi, Kikoman, Vinegar, Kikoman mix
     (grams first, ml second), Tuna Freezer, Spicy Tuna Mix, Tongkatsu sauce,
     Sesame sauce, Kani, Tamago, Butterfly, Hibiscus.
2. Sizes (pack, box, tray...) from his lists.
3. Station items that go into a batch become (linked) ingredients:
   Tako mix, Kikoman, Vinegar, Wasabi, Butterfly, Hibiscus.
4. New ingredients and prep bases:
   - Japanese rice cooked: 2000 g from 1 kg Japanese rice raw.
   - Japanese sushi rice cooked: 4500 g from 4000 g Japanese rice cooked
     (2 batches) + 350 g Vinegar.
   - Tako mix batter: 3500 ml from 1 pack Tako mix + 2400 ml Water + 5 Egg.
   - Kikoman mix: 500 g from 400 g Kikoman + 100 ml Water.
   - Wasabi mix: 200 g from 100 g Wasabi + 100 ml Water.
   - Pearl (tapioca): 2000 g from 1 kg Pearl (raw) (new; priced at 2x the
     cooked cost per g, so the cooked cost stays the same).
   - Butterfly / Hibiscus Tea (batch-brewed): 400 ml from 5 g flowers +
     400 ml Water.
   Each base sits right under its main ingredient on EOD Stock Count.
5. J Rice cooked is merged into Japanese rice cooked: the "Rice" add-on
   takes 120 g of it, its stock moves over, and it's turned off.
6. Maki recipes that took raw rice (220 g a roll, cooked weight) take
   Japanese sushi rice cooked. Otherwise raw rice is taken off twice.
7. Reg. rice (station item) is turned off: there's no regular rice.
8. Small preps nobody logs as batches come off stock straight from their
   raw items on each sale (migration 0089's deduct_mode = auto): Kikoman
   mix, Wasabi mix and the two brewed teas.

Dry run by default; safe to run again:
    cd services/api-fastapi
    .venv/bin/python scripts/apply_joe_inventory.py [--apply]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# kind, old name -> new name
RENAMES = {
    ("ingredient", "Sushi rice (raw)"): "Japanese rice raw",
    ("ingredient", "Steamed rice"): "Japanese rice cooked",
    ("stock_item", "Japanese Rice"): "Japanese rice raw",
}
RAW_RICE, COOKED_RICE, SUSHI_RICE = "Japanese rice raw", "Japanese rice cooked", "Japanese sushi rice cooked"

# (kind, name) -> (new unit, factor = new units in 1 old unit, keep old unit as a size)
UNIT_CHANGES = {
    ("ingredient", "Thai Flavor"): ("g", 25, True),
    ("ingredient", "Okinawa Flavor"): ("g", 25, True),
    ("ingredient", "Hokkaido Flavor"): ("g", 25, True),
    ("ingredient", "Matcha Powder (Drip Tea)"): ("g", 25, True),
    ("ingredient", "Red Choco"): ("g", 25, True),
    ("ingredient", "Taro Flavor"): ("g", 25, True),
    ("ingredient", "Nutella Sauce"): ("g", 10, True),
    ("ingredient", "Cocoa / Creamer"): ("g", 15, True),
    ("ingredient", "Pearl (tapioca)"): ("g", 30, True),
    ("ingredient", "J Rice cooked"): ("g", 120, False),
    ("ingredient", "Kikoman mix"): ("g", 1, False),
    ("stock_item", "Aka"): ("g", 120, False),
    ("stock_item", "Kuro"): ("g", 120, False),
    ("stock_item", "Tantan"): ("g", 120, False),
    ("stock_item", "Spoon"): ("g", 5, True),
    ("stock_item", "Fork"): ("g", 5, True),
    ("stock_item", "Fries"): ("g", 1000, False),
    ("stock_item", "Straw"): ("pcs", 100, True),
    ("stock_item", "Thin straw"): ("pcs", 100, True),
    ("stock_item", "Crabstick"): ("pcs", 180, True),
    ("stock_item", "Tako mix"): ("g", 1000, True),
    ("stock_item", "Wasabi"): ("g", 1, False),
    ("stock_item", "Kikoman"): ("g", 1, False),
    ("stock_item", "Vinegar"): ("g", 1, False),
    ("stock_item", "Tuna Freezer"): ("g", 1, False),
    ("stock_item", "Spicy Tuna Mix"): ("g", 1, False),
    ("stock_item", "Tongkatsu sauce"): ("g", 1, False),
    ("stock_item", "Sesame sauce"): ("g", 1, False),
    ("stock_item", "Kani"): ("g", 1, False),
    ("stock_item", "Tamago"): ("g", 1, False),
    ("stock_item", "Butterfly"): ("g", 1, False),
    ("stock_item", "Hibiscus"): ("g", 1, False),
}
# The ones with factor 1 are only label fixes. They go ahead only while the
# item has no stock; otherwise they wait for a conversion.
LABEL_ONLY = 1
# The Drip Tea powders' 25 g scoop comes from their "kg = 40 scoop" size: check it's there.
SCOOP_FROM_KG = {name for (_k, name), (_u, f, _keep) in UNIT_CHANGES.items() if f == 25}
# Stock right after the change, where the count was really in the new unit.
STOCK_AFTER_CHANGE = {"Cocoa / Creamer": 1000}

# Sizes that are wrong (or built in) once the unit has changed.
DROP_SIZES = {**{name: ["kg"] for name in SCOOP_FROM_KG}, "Pearl (tapioca)": ["kg"], "Cocoa / Creamer": ["sack"]}

# (kind, name) -> {size: main units in one}, in the main unit AFTER step 1.
SIZES = {
    ("ingredient", "Curry"): {"box": 8},
    ("ingredient", "Egg"): {"tray": 30},
    ("ingredient", "Ramen base"): {"cup": 60},
    ("ingredient", "Cooking oil"): {"bottle": 2000},
    ("ingredient", "Nori sheet"): {"pack": 100, "half": 0.5},
    ("ingredient", "Breaded chicken Freezer"): {"pack": 20},
    ("ingredient", "Creamer (milk tea)"): {"pack": 500},
    ("ingredient", "Thai Flavor"): {"pack": 1000},
    ("ingredient", "Okinawa Flavor"): {"pack": 1000},
    ("ingredient", "Hokkaido Flavor"): {"pack": 1000},
    ("ingredient", "Matcha Powder (Drip Tea)"): {"pack": 1000},
    ("ingredient", "Red Choco"): {"pack": 1000},
    ("ingredient", "Taro Flavor"): {"pack": 1000},
    ("ingredient", "Cocoa / Creamer"): {"pack": 1000},
    ("ingredient", "Cheese Cuts"): {"bar": 80, "pack": 80},
    ("stock_item", "Tiny"): {"pack": 100},
    ("stock_item", "Large bag"): {"pack": 100},
    ("stock_item", "Ice bag"): {"pack": 100},
    ("stock_item", "Ice candy bag"): {"pack": 100},
    ("stock_item", "Ramen Nori"): {"pack": 8},
    ("stock_item", "Octo bits"): {"pack": 80},
    ("stock_item", "Chick Nuggets Freezer"): {"whole": 6},
    ("stock_item", "Wasabi"): {"pack": 1000},
    ("stock_item", "Kikoman"): {"ml": 1},
    ("stock_item", "Vinegar"): {"ml": 1},
    ("stock_item", "Bacon Freezer"): {"whole": 16, "pack": 33 * 16},
    ("stock_item", "Crabstick"): {"stick": 6},
}

# Station items that go into a batch: they become (linked) ingredients.
AS_INGREDIENT = ["Tako mix", "Kikoman", "Vinegar", "Wasabi", "Butterfly", "Hibiscus"]

# New ingredients: name -> (unit, category, sizes)
NEW_INGREDIENTS = {
    SUSHI_RICE: ("g", "Rice", {}),
    "Tako mix batter": ("ml", "Batter, sauces & toppings", {}),
    "Wasabi mix": ("g", "Sauces", {}),
    "Pearl (raw)": ("g", "Pearl & sweeteners", {"pack": 1000}),
}
# Pearl (raw) takes the cooked Pearl's spot on the sheet; Pearl then moves under it.
TAKE_SPOT_OF = {"Pearl (raw)": "Pearl (tapioca)"}

# base -> (yield, [(component, qty in its main unit, unit label)]). In order:
# a base made from another base comes after it, so its cost is fresh.
BASES = {
    COOKED_RICE: (2000, [(RAW_RICE, 1000, "kg")]),
    SUSHI_RICE: (4500, [(COOKED_RICE, 4000, "g"), ("Vinegar", 350, "g")]),
    "Tako mix batter": (3500, [("Tako mix", 1000, "pack"), ("Water", 2400, "ml"), ("Egg", 5, "pcs")]),
    "Kikoman mix": (500, [("Kikoman", 400, "g"), ("Water", 100, "ml")]),
    "Wasabi mix": (200, [("Wasabi", 100, "g"), ("Water", 100, "ml")]),
    "Pearl (tapioca)": (2000, [("Pearl (raw)", 1000, "kg")]),
    "Butterfly Pea Tea (batch-brewed)": (400, [("Butterfly", 5, "g"), ("Water", 400, "ml")]),
    "Hibiscus Tea (batch-brewed)": (400, [("Hibiscus", 5, "g"), ("Water", 400, "ml")]),
}
# base -> the row it sits right under. Japanese rice cooked stays in Ramen.
PLACE_UNDER = {
    SUSHI_RICE: RAW_RICE,
    "Tako mix batter": "Tako mix",
    "Kikoman mix": "Kikoman",
    "Wasabi mix": "Wasabi",
    "Pearl (tapioca)": "Pearl (raw)",
    "Butterfly Pea Tea (batch-brewed)": "Butterfly",
    "Hibiscus Tea (batch-brewed)": "Hibiscus",
}

MERGE = ("J Rice cooked", COOKED_RICE)  # from -> into
TURN_OFF_STATION_ITEMS = ["Reg. rice"]
AUTO_MODE = ["Kikoman mix", "Wasabi mix", "Butterfly Pea Tea (batch-brewed)", "Hibiscus Tea (batch-brewed)"]

NOTES = [
    "Spoon & Fork, Ramen spoon(s) and Red spoon w/ chopstick are still in pcs: Sir Joe only answered for Spoon and Fork.",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    apply = args.apply

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from postgrest.exceptions import APIError

    from app.auth import CurrentUser
    from app.deps import get_supabase
    from app.routers.inventory import stock_item_as_ingredient
    from app.routers.inventory_movements import apply_inventory_movement
    from app.routers.prep_bases import _apply_cost, _load

    db = get_supabase()
    owner = CurrentUser(id=None, role="executive", department=None, full_name="script", extra_pages=[])
    changes = 0

    # 0088 in? A bad factor makes the function refuse before it touches anything.
    try:
        db.rpc("change_item_base_unit", {"p_kind": "ingredient", "p_id": "00000000-0000-0000-0000-000000000000",
                                         "p_new_unit": "g", "p_factor": -1}).execute()
        has_0088 = True
    except APIError as e:
        has_0088 = "more than 0" in (e.message or "")
    if not has_0088:
        print("(migration 0088 is not in yet -- dry run only; run 0088_change_base_unit.sql before --apply)")
        if apply:
            return 1

    # Movements need a person: the first executive.
    exec_rows = db.table("profiles").select("id, full_name").eq("role", "executive").limit(1).execute().data
    if not exec_rows:
        print("!! no executive profile to log stock movements under")
        return 1
    mover = exec_rows[0]["id"]

    def load():
        ings = {r["name"]: r for r in db.table("ingredients").select(
            "id, name, base_unit, current_stock, unit_cost, station, sheet_section, sort_order, prep_yield, active").execute().data}
        items = {r["name"]: r for r in db.table("stock_items").select(
            "id, name, station, category, unit, ingredient_id, current_stock, sort_order, active").execute().data}
        units = db.table("item_units").select("id, ingredient_id, stock_item_id, name, base_qty").execute().data
        return ings, items, units

    ings, items, units = load()

    def target(kind, name):
        """(kind, row) after linking: a station item linked to an ingredient is that ingredient."""
        if kind == "ingredient":
            return ("ingredient", ings.get(name))
        s = items.get(name)
        if s and s.get("ingredient_id"):
            linked = next((i for i in ings.values() if i["id"] == s["ingredient_id"]), None)
            return ("ingredient", linked)
        return ("stock_item", s)

    def unit_of(kind, row):
        return (row["base_unit"] if kind == "ingredient" else (row.get("unit") or "pcs")).strip()

    def sizes_of(kind, row):
        col = "ingredient_id" if kind == "ingredient" else "stock_item_id"
        return {u["name"].lower(): u for u in units if u[col] == row["id"]}

    def is_new(row):
        return str(row["id"]).startswith("new:")

    notes = list(NOTES)

    print("0. Renames:")
    for (kind, old), new in RENAMES.items():
        table, rows = ("ingredients", ings) if kind == "ingredient" else ("stock_items", items)
        if old not in rows:
            continue  # renamed already (or never there)
        if new in rows:
            print(f"  !! {old}: '{new}' already exists, not renamed")
            continue
        print(f"  {old} -> {new}")
        changes += 1
        if apply:
            db.table(table).update({"name": new}).eq("id", rows[old]["id"]).execute()
        rows[new] = {**rows.pop(old), "name": new}

    print("1. Main unit changes:")
    converted = set()
    for (kind, name), (new, factor, keep) in UNIT_CHANGES.items():
        k, row = target(kind, name)
        if not row:
            print(f"  !! {name} not found")
            continue
        old = unit_of(k, row)
        if old.lower() == new:
            continue
        if factor == LABEL_ONLY and float(row.get("current_stock") or 0) != 0:
            notes.append(f"{name}: has {row['current_stock']} {old} in stock -- how many {new} is 1 {old}? Not changed.")
            continue
        if name in SCOOP_FROM_KG and not any(u["name"] == "kg" and abs(float(u["base_qty"]) - 40) < 1e-6 for u in sizes_of(k, row).values()):
            notes.append(f"{name}: expected a 'kg = 40 scoop' size to convert from; not changed")
            continue
        stock = float(row.get("current_stock") or 0)
        stock_note = f", stock {stock:g} -> {stock * factor:g}" if factor != 1 else ""
        print(f"  {name}: {old} -> {new} (1 {old} = {factor:g} {new}){stock_note}{'' if keep else ', ' + old + ' not kept'}")
        changes += 1
        converted.add(name)
        if apply:
            db.rpc("change_item_base_unit", {"p_kind": k, "p_id": row["id"], "p_new_unit": new,
                                             "p_factor": factor, "p_keep_old_as_size": keep}).execute()
        # The count was really in the new unit: put it back right away (same
        # step, so a re-run after a stop never misses it).
        if name in STOCK_AFTER_CHANGE:
            want = STOCK_AFTER_CHANGE[name]
            diff = round(stock * factor - want, 4)
            if abs(diff) > 1e-9:
                print(f"     and its stock {stock * factor:g} -> {want:g} {new} (the count was {want:g} {new})")
                changes += 1
                if apply:
                    apply_inventory_movement(db, row["id"], "trans_out" if diff > 0 else "trans_in", abs(diff), mover,
                                             reason=f"Sir Joe: the count was {want:g} {new}, not {old}")
    if apply:
        ings, items, units = load()

    print("   Drop sizes that are wrong or built in now:")
    for name, sizes in DROP_SIZES.items():
        k, row = target("ingredient", name)
        if not row:
            continue
        will_change = name in converted or unit_of(k, row).lower() == UNIT_CHANGES[("ingredient", name)][0]
        for size in sizes:
            u = sizes_of(k, row).get(size)
            if u and will_change:
                print(f"  - {name}: {size} = {float(u['base_qty']):g}")
                changes += 1
                if apply:
                    db.table("item_units").delete().eq("id", u["id"]).execute()
    if apply:
        ings, items, units = load()

    print("2. Sizes:")
    for (kind, name), want in SIZES.items():
        k, row = target(kind, name)
        if not row:
            print(f"  !! {name} not found")
            continue
        have = sizes_of(k, row)
        dropping = set(DROP_SIZES.get(name, [])) if not apply else set()
        planned = UNIT_CHANGES.get((kind, name))
        unit_after = planned[0] if planned and not apply else unit_of(k, row)
        for size, qty in want.items():
            if size in have and size not in dropping:
                if abs(float(have[size]["base_qty"]) - qty) > 1e-6 and not (planned and not apply):
                    print(f"  ~ {name}: {size} is {float(have[size]['base_qty']):g}, Sir Joe says {qty:g} -- left alone")
                continue
            print(f"  + {name}: 1 {size} = {qty:g} {unit_after}")
            changes += 1
            if apply:
                db.table("item_units").insert({
                    "ingredient_id": row["id"] if k == "ingredient" else None,
                    "stock_item_id": row["id"] if k == "stock_item" else None,
                    "name": size, "base_qty": qty,
                }).execute()

    print("3. Station items that go into a batch become ingredients:")
    for name in AS_INGREDIENT:
        s = items.get(name)
        if not s:
            print(f"  !! station item {name} not found")
            continue
        if s.get("ingredient_id"):
            continue
        print(f"  {name} ({s['station']})")
        changes += 1
        if apply:
            ing = stock_item_as_ingredient(s["id"], owner)
            # Its sizes (pack...) belong to the ingredient now: that's the row counted.
            mine = {u["name"].lower() for u in db.table("item_units").select("name").eq("ingredient_id", ing["id"]).execute().data}
            for u in db.table("item_units").select("id, name").eq("stock_item_id", s["id"]).execute().data:
                if u["name"].lower() in mine:
                    db.table("item_units").delete().eq("id", u["id"]).execute()
                else:
                    db.table("item_units").update({"ingredient_id": ing["id"], "stock_item_id": None}).eq("id", u["id"]).execute()
    if apply:
        ings, items, units = load()
    else:  # pretend, for the rest of the dry run
        for name in AS_INGREDIENT:
            s = items.get(name)
            if s and not s.get("ingredient_id") and name not in ings:
                planned = UNIT_CHANGES.get(("stock_item", name))
                ings[name] = {"id": f"new:{name}", "name": name, "base_unit": planned[0] if planned else s["unit"],
                              "station": s["station"], "sheet_section": s["category"], "sort_order": s["sort_order"],
                              "prep_yield": None, "current_stock": 0, "unit_cost": None}

    print("4. New ingredients:")
    for name, (unit, category, sizes) in NEW_INGREDIENTS.items():
        if name in ings:
            continue
        row = {"name": name, "base_unit": unit, "category": category, "current_stock": 0, "reorder_threshold": 0}
        spot_of = ings.get(TAKE_SPOT_OF.get(name, ""))
        if spot_of:
            row.update(station=spot_of["station"], sheet_section=spot_of["sheet_section"], sort_order=spot_of["sort_order"])
        if name == "Pearl (raw)":
            # 1 kg raw -> 2 kg cooked, so raw costs twice the cooked price per g.
            cooked = ings["Pearl (tapioca)"]
            per_g = float(cooked["unit_cost"]) / (1 if apply else UNIT_CHANGES[("ingredient", "Pearl (tapioca)")][1]) \
                if cooked.get("unit_cost") is not None else None
            if per_g is not None:
                row["unit_cost"] = round(per_g * 2, 4)
        cost = f", P{row['unit_cost']}/{unit}" if row.get("unit_cost") is not None else ""
        print(f"  + {name} ({unit}{cost}){', ' + ', '.join(f'{s} = {q:g}' for s, q in sizes.items()) if sizes else ''}")
        changes += 1
        if apply:
            created = db.table("ingredients").insert(row).execute().data[0]
            for s, q in sizes.items():
                db.table("item_units").insert({"ingredient_id": created["id"], "name": s, "base_qty": q}).execute()
        else:
            ings[name] = {"id": f"new:{name}", "prep_yield": None, "current_stock": 0, **{
                "station": None, "sheet_section": None, "sort_order": None, **row}}
    if apply:
        ings, items, units = load()

    print("   Prep bases:")
    for base, (yield_, components) in BASES.items():
        ing = ings.get(base)
        missing = [c for c, _q, _u in components if c not in ings]
        if not ing or missing:
            print(f"  !! {base}: missing {missing or base}")
            continue
        existing = []
        if not is_new(ing):
            existing = db.table("prep_recipe_items").select("ingredient_id, qty").eq("base_ingredient_id", ing["id"]).execute().data
        want = {ings[c]["id"]: float(q) for c, q, _u in components}
        have = {r["ingredient_id"]: float(r["qty"]) for r in existing}
        if want != have or not ing.get("prep_yield") or float(ing["prep_yield"]) != yield_:
            planned = UNIT_CHANGES.get(("ingredient", base))
            unit = planned[0] if planned and not apply else ing["base_unit"]
            print(f"  {base}: makes {yield_:g} {unit} <- " + ", ".join(f"{q:g} {ings[c]['base_unit']} {c}" for c, q, _u in components))
            changes += 1
            if apply:
                db.table("ingredients").update({"prep_yield": yield_}).eq("id", ing["id"]).execute()
                db.table("prep_recipe_items").delete().eq("base_ingredient_id", ing["id"]).execute()
                db.table("prep_recipe_items").insert([
                    {"base_ingredient_id": ing["id"], "ingredient_id": ings[c]["id"], "qty": q, "unit": u, "sort_order": i}
                    for i, (c, q, u) in enumerate(components)
                ]).execute()
                (loaded,) = _load(db, [ing["id"]])
                after = _apply_cost(db, loaded, None, "batch recipe from Sir Joe (2026-11-20)")
                cost = f"P{after.cost_per_unit}/{after.base_unit}" if after.cost_per_unit is not None else f"no cost yet (missing {', '.join(after.missing_cost)})"
                print(f"     -> {cost}")

        # Right under its main ingredient (same station, section, next position).
        if base not in PLACE_UNDER:
            continue
        under = ings.get(PLACE_UNDER[base])
        if not under or under.get("sort_order") is None:
            print(f"  !! {base}: can't place it, {PLACE_UNDER[base]} has no spot on the sheet")
            continue
        spot = (under["station"], under["sheet_section"], under["sort_order"] + 1)
        if (ing.get("station"), ing.get("sheet_section"), ing.get("sort_order")) == spot:
            continue
        print(f"  {base}: placed under {under['name']} ({spot[0]} / {spot[1]})")
        changes += 1
        if apply:
            # Make room: everything at that station from the spot on moves down one.
            for table in ("ingredients", "stock_items"):
                rows = db.table(table).select("id, sort_order").eq("station", spot[0]).gte("sort_order", spot[2]).execute().data
                for r in rows:
                    if r["id"] != ing["id"]:
                        db.table(table).update({"sort_order": r["sort_order"] + 1}).eq("id", r["id"]).execute()
            db.table("ingredients").update({"station": spot[0], "sheet_section": spot[1], "sort_order": spot[2]}).eq("id", ing["id"]).execute()
            ings, items, units = load()

    print(f"5. Merge {MERGE[0]} into {MERGE[1]}:")
    src, dst = ings.get(MERGE[0]), ings.get(MERGE[1])
    if src and dst and src.get("active", True):
        refs = {t: db.table(t).select("ingredient_id").eq("ingredient_id", src["id"]).execute().data
                for t in ("prep_recipe_items", "bundle_ingredient_deductions")}
        if any(refs.values()):
            print(f"  !! {MERGE[0]} is still used in {', '.join(t for t, r in refs.items() if r)} -- not merged")
        else:
            lines = db.table("recipe_items").select("id, qty_per_serving, unit, product_sizes(size_label, products(name))") \
                .eq("ingredient_id", src["id"]).execute().data
            factor = 1 if apply or src["base_unit"] == "g" else UNIT_CHANGES[("ingredient", MERGE[0])][1]
            for line in lines:
                ps = line.get("product_sizes") or {}
                print(f"  {(ps.get('products') or {}).get('name')} {ps.get('size_label')}: "
                      f"{float(line['qty_per_serving']) * factor:g} g of {MERGE[1]}")
                changes += 1
                if apply:
                    db.table("recipe_items").update({"ingredient_id": dst["id"], "unit": "g"}).eq("id", line["id"]).execute()
            stock = round(float(src["current_stock"] or 0) * factor, 4)
            if stock > 0:
                print(f"  stock {stock:g} g moves over")
                changes += 1
                if apply:
                    reason = f"Merged {MERGE[0]} into {MERGE[1]}"
                    apply_inventory_movement(db, src["id"], "trans_out", stock, mover, reason=reason)
                    apply_inventory_movement(db, dst["id"], "trans_in", stock, mover, reason=reason)
            print(f"  {MERGE[0]} (and its station item) turned off")
            changes += 1
            if apply:
                db.table("ingredients").update({"active": False}).eq("id", src["id"]).execute()
                db.table("stock_items").update({"active": False}).eq("ingredient_id", src["id"]).execute()

    print(f"6. Maki recipes: {RAW_RICE} -> {SUSHI_RICE}:")
    raw, sushi = ings.get(RAW_RICE), ings.get(SUSHI_RICE)
    if raw and sushi:
        lines = db.table("recipe_items").select("id, qty_per_serving, unit, product_sizes(size_label, products(name))") \
            .eq("ingredient_id", raw["id"]).execute().data
        for line in lines:
            ps = line.get("product_sizes") or {}
            print(f"  {(ps.get('products') or {}).get('name')} {ps.get('size_label')}: {float(line['qty_per_serving']):g} {line['unit']}")
            changes += 1
            if apply:
                db.table("recipe_items").update({"ingredient_id": sushi["id"], "unit": "g"}).eq("id", line["id"]).execute()

    print("7. Station items turned off:")
    for name in TURN_OFF_STATION_ITEMS:
        s = items.get(name)
        if s and s.get("active"):
            print(f"  {name} ({s['station']}, stock {float(s['current_stock'] or 0):g})")
            changes += 1
            if apply:
                db.table("stock_items").update({"active": False}).eq("id", s["id"]).execute()

    print("8. Taken from raw items on each sale (auto):")
    from app.prep_chain import batches_supported
    if not batches_supported(db):
        print("  (migration 0089 is not in yet -- skipped)")
    else:
        modes = {r["name"]: r for r in db.table("ingredients").select("id, name, deduct_mode").in_("name", AUTO_MODE).execute().data}
        for name in AUTO_MODE:
            row = modes.get(name)
            if not row and name in ings and is_new(ings[name]):
                print(f"  {name} (after it's created)")
                changes += 1
                continue
            if not row:
                print(f"  !! {name} not found")
                continue
            if row["deduct_mode"] != "auto":
                print(f"  {name}")
                changes += 1
                if apply:
                    db.table("ingredients").update({"deduct_mode": "auto"}).eq("id", row["id"]).execute()

    print("\nNotes (not changed):")
    for n in notes:
        print(f"  ? {n}")
    print(f"\n{changes} change(s){'' if apply else ' (dry run -- add --apply)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
