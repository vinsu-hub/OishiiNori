"""Sir Joe's prep batches ("pre-base") and the crab stick cut (2026-11-18).

Prep bases (needs migration 0086). The base is the ingredient the menu
recipes already use, renamed; one batch's components go into
prep_recipe_items and prep_yield says how much a batch makes, so the base's
cost per scoop / ml follows the components' costs (app/routers/prep_bases.py).

    Milk tea base  5 L water + 1 pack tea bag + 500 g creamer      -> 5000 ml
    Mousse base    300 g mousse powder + 2 Nestle cream + 600 ml full
                   cream milk + 80 g fructose                       -> scoops (estimate)
    Hot Mayo       100 g sriracha + 200 g Japanese mayo             -> 300 ml

Assumptions, all in the follow-up for Sir Joe: thick sauces 1 g = 1 ml;
fructose syrup 80 g = 62 ml (about 1.3 g/ml); Mousse yield 58 scoops
(about 1.45 kg of mix at 25 g a scoop).

Crab stick: 1 pack = 32 sticks, each stick is cut into 3, and the recipe
numbers are cut pieces (California Maki 8 pcs = 2 cut pieces). Stock stays
counted in whole sticks; a "cut piece" size (1/3 stick) is added and every
recipe line goes from cut pieces to sticks (/ 3). Crazy Maki's "60 g" is left
alone -- it's in the follow-up.

Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_prep_bases.py
    ... --apply
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

RENAMES = {
    "Milktea base (batch-prepped)": "Milk tea base",
    "Mousse mix (Drip Tea)": "Mousse base",
    "Spicy mayo": "Hot Mayo",
}

# New component ingredients: name -> (base unit, category, unit cost or None, note)
NEW = {
    "Tea bag": ("pack", "Drip Tea", None, "milk tea base"),
    "Creamer (milk tea)": ("g", "Drip Tea", None, "milk tea base"),
    "Nestle cream": ("pack", "Drip Tea", None, "mousse"),
    # The old Mousse mix price was really the powder's: P550 per kg (estimate).
    "Mousse powder": ("g", "Drip Tea", 0.55, "mousse"),
}

# base -> (yield in the base's unit, [(component, qty in its base unit, unit typed)])
BASES = {
    "Milk tea base": (5000, [("Water", 5000, "L"), ("Tea bag", 1, "pack"), ("Creamer (milk tea)", 500, "g")]),
    "Mousse base": (58, [("Mousse powder", 300, "g"), ("Nestle cream", 2, "pack"),
                         ("Full Cream Milk", 600, "ml"), ("Fructose (Drip Tea)", 62, "ml")]),
    "Hot Mayo": (300, [("Sriracha", 100, "ml"), ("Japanese Mayo", 200, "ml")]),
}

CRAB = "Crab stick"
CUT = "cut piece"
CUTS_PER_STICK = 3
# Recipe lines that are already in sticks or not in pieces at all.
CRAB_SKIP = {("Crazy Maki", "8 pcs")}
# California Maki 8 pcs is 2 cut pieces (Sir Joe; the recipe said 3).
CRAB_SET = {("California Maki", "8 pcs"): 2}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.cost_log import log_unit_cost
    from app.deps import get_supabase
    from app.routers.prep_bases import _apply_cost, _load
    from app.stock_alerts import counts_supported_check

    db = get_supabase()
    has_0086 = counts_supported_check(db)
    if not has_0086:
        print("(migration 0086 is not in yet -- dry run only; run 0086_prep_bases_and_counts.sql before --apply)")
        if args.apply:
            return 1
    changes = 0

    def by_name():
        cols = "id, name, base_unit, unit_cost, category" + (", prep_yield" if has_0086 else "")
        rows = db.table("ingredients").select(cols).execute().data
        return {r["name"]: r for r in rows}

    ings = by_name()

    print("Rename the bases:")
    for old, new in RENAMES.items():
        if old in ings and new not in ings:
            print(f"  {old} -> {new}")
            changes += 1
            if args.apply:
                db.table("ingredients").update({"name": new}).eq("id", ings[old]["id"]).execute()
    if args.apply:
        ings = by_name()
    else:  # pretend, for the rest of the dry run
        for old, new in RENAMES.items():
            if old in ings and new not in ings:
                ings[new] = {**ings.pop(old), "name": new}

    # Sizes that were about the bought product, not the batch: Mousse mix's
    # "kg = 40 scoops" was the powder; Spicy mayo's "pack" was a bought pack.
    print("Drop sizes that described the bought product:")
    for base, unit in (("Mousse base", "kg"), ("Hot Mayo", "pack")):
        ing = ings.get(base)
        if not ing:
            continue
        for u in db.table("item_units").select("id, name, base_qty").eq("ingredient_id", ing["id"]).eq("name", unit).execute().data:
            print(f"  - {base}: {u['name']} = {u['base_qty']}")
            changes += 1
            if args.apply:
                db.table("item_units").delete().eq("id", u["id"]).execute()

    print("New component ingredients:")
    for name, (unit, category, cost, note) in NEW.items():
        if name in ings:
            continue
        print(f"  + {name} ({unit}){f', P{cost}/{unit} (estimate)' if cost is not None else ', no cost yet'}  [{note}]")
        changes += 1
        if args.apply:
            row = db.table("ingredients").insert({
                "name": name, "base_unit": unit, "category": category, "unit_cost": cost,
                "current_stock": 0, "reorder_threshold": 0,
            }).execute().data[0]
            if cost is not None:
                log_unit_cost(db, row["id"], cost, None, price_paid=550, qty=1, unit_name="kg", base_qty=1000,
                              source="import", note="was the Mousse mix price (estimate, 1 kg)")
            ings[name] = row
        else:
            ings[name] = {"id": f"new:{name}", "name": name, "base_unit": unit, "unit_cost": cost, "prep_yield": None}

    print("Batch recipes:")
    for base, (yield_, components) in BASES.items():
        ing = ings.get(base)
        if not ing:
            print(f"  !! {base} not found")
            continue
        missing = [c for c, _q, _u in components if c not in ings]
        if missing:
            print(f"  !! {base}: missing {missing}")
            continue
        existing = []
        if has_0086 and not ing["id"].startswith("new:"):
            existing = db.table("prep_recipe_items").select("ingredient_id, qty").eq("base_ingredient_id", ing["id"]).execute().data
        want = {ings[c]["id"]: float(q) for c, q, _u in components}
        have = {r["ingredient_id"]: float(r["qty"]) for r in existing}
        if want == have and ing.get("prep_yield") and float(ing["prep_yield"]) == yield_:
            continue
        print(f"  {base}: makes {yield_} {ing['base_unit']} <- " + ", ".join(f"{q} {ings[c]['base_unit']} {c}" for c, q, _u in components))
        changes += 1
        if args.apply:
            db.table("ingredients").update({"prep_yield": yield_}).eq("id", ing["id"]).execute()
            db.table("prep_recipe_items").delete().eq("base_ingredient_id", ing["id"]).execute()
            db.table("prep_recipe_items").insert([
                {"base_ingredient_id": ing["id"], "ingredient_id": ings[c]["id"], "qty": q, "unit": u, "sort_order": i}
                for i, (c, q, u) in enumerate(components)
            ]).execute()
            (loaded,) = _load(db, [ing["id"]])
            after = _apply_cost(db, loaded, None, "batch recipe from Sir Joe (2026-11-18)")
            cost = f"P{after.cost_per_unit}/{after.base_unit}" if after.cost_per_unit is not None else f"no cost yet (missing {', '.join(after.missing_cost)})"
            print(f"     -> {cost}")

    print("Crab stick cut pieces:")
    crab = ings.get(CRAB)
    if crab:
        units = db.table("item_units").select("id, name").eq("ingredient_id", crab["id"]).execute().data
        if not any(u["name"].lower() == CUT for u in units):
            print(f"  + size '{CUT}' = 1/{CUTS_PER_STICK} stick")
            changes += 1
            if args.apply:
                db.table("item_units").insert({"ingredient_id": crab["id"], "name": CUT, "base_qty": round(1 / CUTS_PER_STICK, 4)}).execute()
        lines = db.table("recipe_items").select("id, product_size_id, qty_per_serving, unit, product_sizes(size_label, products(name))") \
            .eq("ingredient_id", crab["id"]).execute().data
        marker = "cut pieces"  # prep_notes marker: this line was already converted
        notes = {r["id"]: r for r in db.table("recipe_items").select("id, prep_notes").eq("ingredient_id", crab["id"]).execute().data}
        for line in lines:
            key = (line["product_sizes"]["products"]["name"], line["product_sizes"]["size_label"])
            if key in CRAB_SKIP or marker in (notes[line["id"]].get("prep_notes") or ""):
                continue
            pieces = CRAB_SET.get(key, float(line["qty_per_serving"]))
            sticks = round(pieces / CUTS_PER_STICK, 4)
            print(f"  {key[0]} ({key[1]}): {line['qty_per_serving']} {line['unit']} -> {pieces:g} cut pieces = {sticks} stick")
            changes += 1
            if args.apply:
                db.table("recipe_items").update({
                    "qty_per_serving": sticks, "unit": crab["base_unit"],
                    "prep_notes": " · ".join(filter(None, [f"{pieces:g} {marker} (1 stick = {CUTS_PER_STICK})", notes[line["id"]].get("prep_notes")])),
                }).eq("id", line["id"]).execute()
    print(f"\n{changes} change(s){'' if args.apply else ' (dry run -- add --apply)'}")
    if args.apply:
        print("Then: scripts/apply_ingredient_sheet_layout.py --apply (puts the new ingredients on the EOD count sheet)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
