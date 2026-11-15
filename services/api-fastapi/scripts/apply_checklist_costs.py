"""Load Sir Joe's filled-in "Recipes and Unit Costs Checklist" workbook.

He wrote the price paid in column F, left the quantity at 1, and typed the
pack size as text in column I ("20 liters per gallon"), so the sheet's own
cost-per-unit is wrong. COSTS below is the reviewed reading of each row:
price and how many recipe units that price buys. Rows marked as estimates
rest on an assumption the follow-up workbook asks him to confirm.

Also applies his clear renames/merges, the unit fixes where recipes already
count pieces or packs, and the two recipes he added. Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_checklist_costs.py "<checklist>.xlsx"
    ... --apply
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

RENAMES = {
    "Scallion": "Spring onion",
    "Gyoza wrapper": "Gyoza",
    "Star Jelly": "Nata",
    "Egg (Tamago / soft-boiled)": "Egg",
    "Ramen broth (batch-prepped)": "Ramen base",
    "Red Choco / Creamer": "Red Choco",
    "Tanuki (tempura bits)": "Tanuki",
    "Teriyaki glaze": "Teriyaki",
    "Tuna (raw, spicy tuna mix)": "Tuna",
    "Tempura batter / panko breading": "Panko bread crumbs",
}
# old -> kept; recipes and station items move to the kept ingredient. The old
# row stays (its sales history references it) unless nothing points at it.
MERGES = {
    "Milk": "Full Cream Milk",
    "Breaded shrimp (Ebi)": "Breaded prawn",
    # Its recipes say 3 / 2 / 1 "g" on Oishii Nori Ramen / Pork Teriyaki /
    # Chasu Ramen: slice counts typed as grams, so they move over unchanged
    # as Chasu pieces (to confirm in the follow-up sheet).
    "Pork belly (Chasu)": "Chasu",
}
# Recipes already count these in pieces/packs, not grams.
UNITS = {"Ramen noodles": "pack", "Shrimp / Prawn (raw)": "pcs", "Breaded prawn": "pcs"}
# An empty duplicate added on the dashboard (2026-11-14, unit "grams", one
# Gyudon line, no stock history) folds into the long-used row, which is then
# renamed (RENAMES). Runs before the renames; the empty row is deleted.
FOLD_FIRST = {"Spring onion": "Scallion", "EGG": "Egg (Tamago / soft-boiled)"}

# name (after renames) -> (price paid, recipe units it buys, note, estimate?)
COSTS = {
    "Fructose (Drip Tea)": (1500, 20000, "20 L per gallon", False),
    "Pearl (tapioca)": (100, 40, "1 kg raw = 40 scoops (25 g each)", True),
    "Milktea base (batch-prepped)": (23.5, 5000, "5 L per batch", False),
    "Mousse mix (Drip Tea)": (550, 40, "1 kg = 40 scoops (25 g each)", True),
    "Cocoa / Creamer": (4500, 1000, "25 kg sack = 1,000 scoops (25 g each)", True),
    "Yogurt Syrup": (350, 1000, "pack size not given; assumed 1 L", True),
    "Matcha Powder (Drip Tea)": (450, 40, "1 kg = 40 scoops (25 g each)", True),
    "Oreo Crumble": (175, 50, "pack size not given; assumed 500 g, 10 g per scoop", True),
    "Thai Flavor": (350, 40, "assumed 1 kg = 40 scoops (25 g each)", True),
    "Cookie Crumble": (350, 50, "500 g = 50 scoops (10 g each)", True),
    "Taro Flavor": (350, 40, "1 kg = 40 scoops (25 g each)", True),
    "W.M Syrup": (750, 7000, "7 L per gallon", False),
    "B.S Syrup": (400, 2000, "2 L per batch", False),
    "C.D Syrup": (350, 1000, "1 L per bottle", False),
    "Charcoal Powder": (75, 100, "100 g per pack", False),
    "Full Cream Milk": (85, 1000, "1 L per pack", False),
    "Hokkaido Flavor": (350, 40, "1 kg = 40 scoops (25 g each)", True),
    "Nutella Sauce": (378, 90, "900 g = 90 stirrers (10 g each)", True),
    "Okinawa Flavor": (350, 40, "1 kg = 40 scoops (25 g each)", True),
    "Red Choco": (450, 40, "1 kg = 40 scoops (25 g each)", True),
    "Steamed rice": (65, 2200, "1 kg raw cooks to about 2.2 kg", True),
    "Sushi rice (raw)": (78, 1000, "1 kg per pack", False),
    "Ramen noodles": (17, 1, "per pack, 1 pack per bowl", False),
    "Rice vinegar seasoning mix": (93, 1000, "1 L per bottle", False),
    "Special mayo (house)": (300, 1000, "1 kg per pack (1 g = 1 ml)", False),
    "Spicy mayo": (350, 1000, "1 kg per pack (1 g = 1 ml)", False),
    "Yakiniku sauce": (290, 1000, "1 L per bottle", False),
    "Gyoza dipping sauce": (1900, 20000, "20 L per box", False),
    "Katsu sauce": (278, 3785, "1 gallon = 3,785 ml", False),
    "Oishii salad sauce (house)": (250, 1000, "1 L per bottle", False),
    "Cream cheese": (1075, 2000, "2 kg per box", False),
    "Mozzarella cheese": (1375, 2000, "2 kg per box", False),
    "Parmesan cheese": (375, 250, "250 g per bottle", False),
    "Nori sheet": (678, 200, "200 sheets per pack", False),
    "Gyoza": (9.32, 1, "per piece", False),
    "Ebiko (fish roe)": (850, 500, "500 g per tub", False),
    "Tanuki": (50, 100, "100 g per pack", False),
    "Panko bread crumbs": (580, 2000, "2 kg per pack", False),
    "Chopsticks": (1, 1, "₱1 each (sheet also says 100 pcs per pack)", True),
    "Salted Nori": (16, 1, "per pack", False),
    "Cucumber": (650, 10000, "10 kg per bundle", False),
    "Cabbage (slaw)": (650, 10000, "10 kg per bundle", False),
    "Spring onion": (400, 1000, "1 kg per pack", False),
    "Mango": (250, 1000, "1 kg per pack", False),
    "Lettuce": (80, 1000, "per kg", False),
    "Carrot": (25, 150, "₱25 per carrot, about 150 g", True),
    "Onion": (3, 60, "₱3 per bulb, about 60 g", True),
    "Crab stick": (250, 32, "32 pcs per pack", False),
    "Tuna": (195, 500, "500 g per pack", False),
    "Shrimp / Prawn (raw)": (275, 30, "30 pcs per pack", False),
    "Breaded prawn": (275, 20, "20 pcs per pack", False),
    "Scallop": (180, 200, "200 g per pack", False),
    "Tempura shrimp": (295, 15, "15 pcs per pack", False),
    "Ice": (200, 25000, "₱200 per sack, assumed 25 kg", True),
    "Egg": (7.5, 1, "per egg", False),
    "Beef (sliced)": (55, 100, "100 g per pack", False),
    "Chicken (cutlet)": (35, 1, "per piece", False),
    "Pork (cutlet)": (45, 1, "per piece", False),
    "Ramen base": (320, 1000, "1 L per bottle", False),
    "Crispy potato string": (1200, 10000, "10 kg per bundle", False),
    "Crispy kani (garnish, batch-prepped)": (250, 500, "500 g per pack", False),
    "Chasu": (480, 20, "500 g pack, about 25 g per slice", True),
    "Sriracha": (375, 888, "888 ml per bottle", False),
    "Bonito Flakes": (775, 500, "500 g per pack", False),
    "Japanese Mayo": (300, 1000, "₱300 per bottle, assumed 1 L", True),
    "Water": (0, 1, "tap water, no cost", False),
}

# Sizes they buy in, so the next price is just "P1050 for 1 box" (item_units,
# migration 0061). kg / L / gallon / lb are built in and not listed. Scoop
# and stirrer sizes rest on the same estimates as COSTS above.
PACKS = [
    ("Cream cheese", "box", 2000), ("Mozzarella cheese", "box", 2000), ("Parmesan cheese", "bottle", 250),
    ("Fructose (Drip Tea)", "container", 20000), ("W.M Syrup", "container", 7000),
    ("Milktea base (batch-prepped)", "batch", 5000), ("B.S Syrup", "batch", 2000), ("C.D Syrup", "bottle", 1000),
    ("Charcoal Powder", "pack", 100), ("Full Cream Milk", "pack", 1000), ("Yakiniku sauce", "bottle", 1000),
    ("Gyoza dipping sauce", "box", 20000), ("Oishii salad sauce (house)", "bottle", 1000),
    ("Rice vinegar seasoning mix", "bottle", 1000), ("Special mayo (house)", "pack", 1000), ("Spicy mayo", "pack", 1000),
    ("Ebiko (fish roe)", "tub", 500), ("Tanuki", "pack", 100), ("Panko bread crumbs", "pack", 2000),
    ("Cucumber", "bundle", 10000), ("Cabbage (slaw)", "bundle", 10000), ("Crispy potato string", "bundle", 10000),
    ("Spring onion", "pack", 1000), ("Mango", "pack", 1000), ("Sushi rice (raw)", "pack", 1000),
    ("Crab stick", "pack", 32), ("Tuna", "pack", 500), ("Shrimp / Prawn (raw)", "pack", 30), ("Breaded prawn", "pack", 20),
    ("Scallop", "pack", 200), ("Tempura shrimp", "pack", 15), ("Beef (sliced)", "pack", 100), ("Ramen base", "bottle", 1000),
    ("Crispy kani (garnish, batch-prepped)", "pack", 500), ("Sriracha", "bottle", 888), ("Bonito Flakes", "pack", 500),
    ("Chopsticks", "pack", 100), ("Chasu", "pack", 20), ("Ice", "sack", 25000), ("Japanese Mayo", "bottle", 1000),
    ("Yogurt Syrup", "bottle", 1000),
    # scoop / stirrer counted, from the 25 g (10 g) per scoop estimate
    ("Pearl (tapioca)", "kg", 40), ("Mousse mix (Drip Tea)", "kg", 40), ("Matcha Powder (Drip Tea)", "kg", 40),
    ("Thai Flavor", "kg", 40), ("Taro Flavor", "kg", 40), ("Hokkaido Flavor", "kg", 40), ("Okinawa Flavor", "kg", 40),
    ("Red Choco", "kg", 40), ("Cocoa / Creamer", "sack", 1000), ("Cookie Crumble", "pack", 50), ("Oreo Crumble", "pack", 50),
    ("Nutella Sauce", "bottle", 90),
]

# (product, size label, ingredient, qty) from the "Recipes to add" sheet
RECIPES = [("Extra Egg", "pc", "Egg", 1), ("Xtra Chasu", "Regular", "Chasu", 1)]


def sheet_prices(path: str) -> dict[str, float]:
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True)["Unit costs to add"]
    prices = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        name, price = row[1], row[5]
        if name and isinstance(price, (int, float)):
            prices.setdefault(str(name).strip().lower(), float(price))
    return prices


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase
    db = get_supabase()

    # Sheet-side spellings of renamed rows, to cross-check prices.
    sheet = sheet_prices(args.workbook)
    sheet_alias = {"spring onion": "spring onion", "gyoza": "gyoza", "egg": "egg (tamago / soft-boiled)",
                   "ramen base": "ramen broth (batch-prepped)", "red choco": "red choco / creamer",
                   "tanuki": "tanuki (tempura bits)", "tuna": "tuna (raw, spicy tuna mix)",
                   "panko bread crumbs": "tempura batter / panko breading"}
    for name, (price, *_rest) in COSTS.items():
        got = sheet.get(sheet_alias.get(name.lower(), name.lower()))
        if got is not None and abs(got - price) > 1e-6:
            print(f"  !! sheet price for {name!r} is {got}, COSTS says {price}")

    ingredients = db.table("ingredients").select("id,name,base_unit,unit_cost").execute().data
    by_name = {i["name"]: i for i in ingredients}
    changes = 0
    from app.cost_log import log_unit_cost
    # the size a price was paid for, when it's one of PACKS ("1 box")
    pack_name = {n: u for n, u, q in PACKS if COSTS.get(n, (0, None))[1] == q}

    def write(table, patch, **eq):
        if args.apply:
            q = db.table(table).update(patch)
            for k, v in eq.items():
                q = q.eq(k, v)
            q.execute()

    print("Fold empty duplicates:")
    for dup, keep in FOLD_FIRST.items():
        if dup not in by_name or keep not in by_name:
            continue
        dup_id, keep_id = by_name[dup]["id"], by_name[keep]["id"]
        moves = db.table("inventory_movements").select("id", count="exact").eq("ingredient_id", dup_id).limit(1).execute().count
        if moves:
            print(f"  !! {dup} has {moves} stock movements; not folding")
            continue
        rows = db.table("recipe_items").select("id, product_size_id").eq("ingredient_id", dup_id).execute().data
        kept_sizes = {r["product_size_id"] for r in
                      db.table("recipe_items").select("product_size_id").eq("ingredient_id", keep_id).execute().data}
        if any(r["product_size_id"] in kept_sizes for r in rows):
            print(f"  !! a recipe uses both {dup} and {keep}; fix it in Menu Editing first")
            continue
        changes += 1
        print(f"  {dup} -> {keep}: {len(rows)} recipe line(s), then the empty {dup} row is removed")
        if args.apply:
            if rows:
                db.table("recipe_items").update({"ingredient_id": keep_id, "unit": by_name[keep]["base_unit"]}).eq("ingredient_id", dup_id).execute()
            db.table("item_units").delete().eq("ingredient_id", dup_id).execute()
            try:
                db.table("ingredients").delete().eq("id", dup_id).execute()
            except Exception as exc:  # something else still points at it: park it instead
                print(f"  (could not delete {dup}: {exc}; renamed to '{dup} (unused)')")
                db.table("ingredients").update({"name": f"{dup} (unused)"}).eq("id", dup_id).execute()
        by_name.pop(dup)

    print("Renames:")
    for old, new in RENAMES.items():
        if old in by_name and new not in by_name:
            changes += 1
            print(f"  {old} -> {new}")
            write("ingredients", {"name": new}, id=by_name[old]["id"])
            by_name[new] = {**by_name.pop(old), "name": new}

    print("Merges:")
    for old, keep in MERGES.items():
        if old not in by_name or keep not in by_name:
            continue
        old_id, keep_id = by_name[old]["id"], by_name[keep]["id"]
        for table in ("recipe_items", "stock_items"):
            rows = db.table(table).select("id").eq("ingredient_id", old_id).execute().data
            if rows:
                changes += 1
                print(f"  {old} -> {keep}: {len(rows)} {table}")
                patch = {"ingredient_id": keep_id}
                if table == "recipe_items":
                    patch["unit"] = UNITS.get(keep, by_name[keep]["base_unit"])
                write(table, patch, ingredient_id=old_id)
        history = db.table("inventory_movements").select("id", count="exact").eq("ingredient_id", old_id).limit(1).execute().count
        print(f"  ({old} kept: {history} stock movements reference it)")

    print("Units:")
    for name, unit in UNITS.items():
        ing = by_name.get(name)
        if ing and ing["base_unit"] != unit:
            changes += 1
            print(f"  {name}: {ing['base_unit']} -> {unit}")
            write("ingredients", {"base_unit": unit}, id=ing["id"])
            ing["base_unit"] = unit

    print("Unit costs:")
    for name, (price, qty, note, estimate) in COSTS.items():
        ing = by_name.get(name)
        if not ing:
            print(f"  !! no ingredient {name!r}")
            continue
        cost = round(price / qty, 4)
        if ing["unit_cost"] is not None and abs(float(ing["unit_cost"]) - cost) < 1e-6:
            continue
        changes += 1
        flag = " (estimate)" if estimate else ""
        print(f"  {name:<38} ₱{cost:>9.4f}/{ing['base_unit']:<7} {note}{flag}")
        write("ingredients", {"unit_cost": cost}, id=ing["id"])
        if args.apply:
            log_unit_cost(db, ing["id"], cost, ing["unit_cost"], price_paid=price, qty=1,
                          unit_name=pack_name.get(name), base_qty=qty, source="import",
                          note=f"Checklist 2026-10-23: {note}" + (" (estimate)" if estimate else ""))

    print("Pack sizes:")
    existing_units = db.table("item_units").select("ingredient_id,name").not_.is_("ingredient_id", "null").execute().data
    have = {(u["ingredient_id"], u["name"].lower()) for u in existing_units}
    for name, unit, base_qty in PACKS:
        ing = by_name.get(name)
        if not ing:
            print(f"  !! no ingredient {name!r}")
            continue
        if (ing["id"], unit.lower()) in have:
            continue
        changes += 1
        print(f"  {name}: 1 {unit} = {base_qty:g} {ing['base_unit']}")
        if args.apply:
            db.table("item_units").insert({"ingredient_id": ing["id"], "name": unit, "base_qty": base_qty}).execute()

    print("Recipes:")
    for product, size, ingredient, qty in RECIPES:
        sizes = (db.table("product_sizes").select("id,size_label,products!inner(name)")
                 .eq("products.name", product).eq("size_label", size).execute().data)
        ing = by_name.get(ingredient)
        if len(sizes) != 1 or not ing:
            print(f"  !! {product} ({size}) / {ingredient}: not found")
            continue
        if db.table("recipe_items").select("id").eq("product_size_id", sizes[0]["id"]).limit(1).execute().data:
            continue
        changes += 1
        print(f"  {product} ({size}) = {qty} x {ingredient}")
        if args.apply:
            db.table("recipe_items").insert(
                {"product_size_id": sizes[0]["id"], "ingredient_id": ing["id"], "qty_per_serving": qty}
            ).execute()

    print(f"\n{changes} change(s)." + ("" if args.apply else " Dry run; re-run with --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
