"""Deploy-night setup for migration 0090 (platter standard mix).

1. Close the platter orders stuck in "Recipe units need review" without
   taking stock: they're old, and stock gets a fresh count anyway.
2. Put recipe lines in their ingredient's own unit: "pc" -> "pcs" is just
   a label; Crazy Maki's crab stick and Cheesy Katsu's mozzarella need Sir
   Joe's numbers (--crab-pcs, --mozz-g-per-slice) and are skipped without.
3. Save the standard mix of each platter, from what the kitchen logged
   most (Sir Joe can change them in Menu Editing).
4. Takeout packaging: 1 disposable Spoon + 1 Fork (5 g = 1 pc each) come
   off stock once per takeout order. They become ingredients so Sir Joe can
   type their cost in Recipes & Costs -> Unit costs (no price yet).

Dry run by default. Run:  .venv/bin/python scripts/apply_platter_setup.py [--apply]
  [--crab-pcs 0.67] [--mozz-g-per-slice 20]
Re-running is safe: done steps report 0.
"""
import argparse
import os
import sys

MIXES = {  # platter -> {roll: pieces}
    "Small Platter": {"California Maki": 8, "Crazy Maki": 8, "Dragon Maki": 8, "Torikatsu Maki": 8},
    "Medium Platter": {"California Maki": 8, "Crazy Maki": 8, "Crunchy Kani Maki": 8, "Dragon Maki": 8, "Torikatsu Maki": 16},
    "Large Platter": {"California Maki": 16, "Crazy Maki": 8, "Crunchy Kani Maki": 8, "Dragon Maki": 16, "Torikatsu Maki": 16},
    "California Platter": {"California Maki": 32},
}
SAME = {"pc": "pcs", "piece": "pcs", "pieces": "pcs"}
TAKEOUT_PACKAGING = {"Spoon": 5, "Fork": 5}  # station item -> qty in its unit (g) per takeout order
CLOSE_NOTE = "Closed without deduction, before fresh stock count (2026-11)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--crab-pcs", type=float, help="crab stick pcs in one Crazy Maki (8 pcs)")
    ap.add_argument("--mozz-g-per-slice", type=float, help="grams in one mozzarella slice")
    args = ap.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from app.deps import get_supabase
    from app.routers.sales_insights import _page_rows

    db = get_supabase()
    go = args.apply
    print("APPLY" if go else "DRY RUN (add --apply)")

    # 1. Close stuck platter orders
    pending = db.table("bundle_pending_deductions").select("transaction_item_id").is_("resolved_at", "null").execute().data or []
    print(f"\n1. Pending platter orders to close: {len(pending)}")
    if go and pending:
        from datetime import datetime, timezone
        ids = [p["transaction_item_id"] for p in pending]
        for i in range(0, len(ids), 200):
            db.table("bundle_pending_deductions").update({
                "resolved_at": datetime.now(timezone.utc).isoformat(), "closed_without_deduction": True,
                "closed_note": CLOSE_NOTE,
            }).in_("transaction_item_id", ids[i:i + 200]).is_("resolved_at", "null").execute()

    # 2. Recipe units
    rows = _page_rows(db.table("recipe_items").select(
        "id, qty_per_serving, unit, ingredients(name, base_unit), product_sizes(products(name, active))").order("id"))
    print("\n2. Recipe lines not in their ingredient's unit:")
    fixed = 0
    for r in rows:
        ing = r.get("ingredients") or {}
        base, unit = ing.get("base_unit"), r["unit"]
        if not base or unit == base:
            continue
        product = ((r.get("product_sizes") or {}).get("products") or {})
        label = f"   {product.get('name')} | {ing.get('name')} {r['qty_per_serving']} {unit} (counted in {base})"
        change = None
        if SAME.get(unit.lower()) == base or (unit.lower() == base.lower()):
            change = {"unit": base}
        elif ing.get("name") == "Crab stick" and product.get("name") == "Crazy Maki":
            if args.crab_pcs:
                change = {"qty_per_serving": args.crab_pcs, "unit": base}
        elif ing.get("name") == "Mozzarella cheese" and unit.lower() in ("slice", "slices"):
            if args.mozz_g_per_slice:
                change = {"qty_per_serving": round(float(r["qty_per_serving"]) * args.mozz_g_per_slice, 4), "unit": base}
        if not product.get("active", True) or "test" in (product.get("name") or "").lower():
            print(label, "-> skip (test / inactive item)")
            continue
        print(label, "->", change or "WAITING for Sir Joe's number")
        if change:
            fixed += 1
            if go:
                db.table("recipe_items").update(change).eq("id", r["id"]).execute()
    print(f"   {fixed} line(s) {'fixed' if go else 'to fix'}")

    # 3. Standard platter mixes
    products = {p["name"]: p["id"] for p in db.table("products").select("id, name").execute().data or []}
    comps = db.table("bundle_components").select("product_size_id, total_pieces, product_sizes(products(name))").execute().data or []
    try:
        existing = {r["product_size_id"] for r in db.table("bundle_default_mix").select("product_size_id").execute().data or []}
    except Exception:
        if go:
            raise SystemExit("Migration 0090 isn't applied yet -- paste it in the SQL Editor first")
        existing = set()
        print("   (0090 not applied yet; showing what would be saved)")
    print("\n3. Platter standard mixes:")
    for c in comps:
        name = ((c.get("product_sizes") or {}).get("products") or {}).get("name")
        mix = MIXES.get(name)
        if not mix:
            continue
        if c["product_size_id"] in existing:
            print(f"   {name}: already set, left as is")
            continue
        if sum(mix.values()) != c["total_pieces"]:
            print(f"   {name}: mix is {sum(mix.values())} pcs but platter is {c['total_pieces']} -- SKIPPED")
            continue
        missing = [r for r in mix if r not in products]
        if missing:
            print(f"   {name}: unknown rolls {missing} -- SKIPPED")
            continue
        print(f"   {name}: {', '.join(f'{r} {n}' for r, n in mix.items())}")
        if go:
            db.table("bundle_default_mix").insert([
                {"product_size_id": c["product_size_id"], "roll_product_id": products[r], "pieces": n} for r, n in mix.items()
            ]).execute()


    # 4. Takeout spoon + fork
    print("\n4. Takeout packaging, once per takeout order:")
    from app.auth import CurrentUser
    from app.routers.inventory import stock_item_as_ingredient
    owner = CurrentUser(id=None, role="executive", department=None, full_name="script", extra_pages=[])
    rules = db.table("stock_consumption_rules").select("stock_item_id, order_type, trigger_type, active").execute().data or []
    for name, qty in TAKEOUT_PACKAGING.items():
        found = db.table("stock_items").select("id, name, unit, ingredient_id").eq("name", name).eq("active", True).execute().data
        if len(found) != 1:
            print(f"   !! {name}: {len(found)} station items with that name -- SKIPPED")
            continue
        item = found[0]
        if not item.get("ingredient_id"):
            print(f"   {name}: link as an ingredient (so it gets a cost)")
            if go:
                ing = stock_item_as_ingredient(item["id"], owner)
                mine = {u["name"].lower() for u in db.table("item_units").select("name").eq("ingredient_id", ing["id"]).execute().data}
                for u in db.table("item_units").select("id, name").eq("stock_item_id", item["id"]).execute().data:
                    if u["name"].lower() in mine:
                        db.table("item_units").delete().eq("id", u["id"]).execute()
                    else:
                        db.table("item_units").update({"ingredient_id": ing["id"], "stock_item_id": None}).eq("id", u["id"]).execute()
        if any(r["stock_item_id"] == item["id"] and r["trigger_type"] == "per_transaction" and r["order_type"] == "takeout"
               for r in rules):
            print(f"   {name}: takeout rule already there")
            continue
        print(f"   {name}: -{qty} {item['unit']} (1 pc) on every takeout order")
        if go:
            db.table("stock_consumption_rules").insert({
                "stock_item_id": item["id"], "trigger_type": "per_transaction", "order_type": "takeout",
                "qty_per_unit": qty, "scale_by_guest_count": False, "active": True,
                "notes": "Disposable spoon/fork, once per takeout order",
            }).execute()


if __name__ == "__main__":
    main()
