"""Apply the October menu from the supplied menu boards to the shared POS/web catalog.

Dry-run by default. Apply only after migration 0072 has been applied:
  services/api-fastapi/.venv/bin/python services/api-fastapi/scripts/sync_october_menu.py
  services/api-fastapi/.venv/bin/python services/api-fastapi/scripts/sync_october_menu.py --apply
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.deps import get_supabase

APPLY = "--apply" in sys.argv
sb = get_supabase()
products = sb.table("products").select("*,product_sizes(*)").execute().data
by_name = {}
for product in products:
    key = product["name"].casefold()
    if key not in by_name or (product.get("active") and not by_name[key].get("active")):
        by_name[key] = product


def log(message: str) -> None:
    print(message)


def update_product(product_name: str, **fields) -> dict | None:
    row = by_name.get(product_name.casefold())
    if not row:
        log(f"MISSING: {product_name}")
        return None
    if fields.get("department") == "cafe":
        fields.setdefault("takeout_bowl_eligible", False)
    changed = {key: value for key, value in fields.items() if row.get(key) != value}
    if changed:
        log(f"UPDATE {product_name}: {changed}")
        if APPLY:
            sb.table("products").update(changed).eq("id", row["id"]).execute()
        row.update(changed)
        if "name" in changed:
            by_name.pop(product_name.casefold(), None)
            by_name[changed["name"].casefold()] = row
    return row


def update_size(product: dict, old_label: str, *, new_label: str | None = None, price: float | None = None, deposit: float | None = None) -> None:
    row = next((size for size in product["product_sizes"] if size["size_label"] == old_label), None)
    if not row:
        log(f"MISSING SIZE: {product['name']} / {old_label}")
        return
    changes = {}
    if new_label is not None and row["size_label"] != new_label:
        changes["size_label"] = new_label
    if price is not None and float(row["price"]) != price:
        changes["price"] = price
    if deposit is not None and float(row.get("deposit_amount") or 0) != deposit:
        changes["deposit_amount"] = deposit
    if not changes:
        return
    log(f"UPDATE SIZE {product['name']} / {old_label}: {changes}")
    if APPLY:
        sb.table("product_sizes").update(changes).eq("id", row["id"]).execute()
    row.update(changes)


def ensure_product(name: str, category: str, price: float, size: str, *, station: str = "hot_line", department: str = "kitchen", active: bool = True, bundle: bool = False) -> dict:
    row = by_name.get(name.casefold())
    if row:
        update_product(name, category=category, active=active, is_bundle=bundle, takeout_bowl_eligible=(department == "kitchen" and "extra" not in category.casefold()))
        row = by_name[name.casefold()]
        size_row = next((s for s in row["product_sizes"] if s["size_label"] == size), None)
        if size_row:
            update_size(row, size, price=price)
        else:
            log(f"ADD SIZE {name}: {size} @ {price:g}")
            if APPLY:
                inserted = sb.table("product_sizes").insert({"product_id": row["id"], "size_label": size, "price": price, "sort_order": len(row["product_sizes"])}).execute().data[0]
                row["product_sizes"].append(inserted)
        return row

    log(f"CREATE {name}: {category}, {size} @ {price:g}{' (hidden draft)' if not active else ''}")
    if not APPLY:
        return {"id": f"dry-run:{name}", "name": name, "category": category, "product_sizes": [], "is_bundle": bundle}
    row = sb.table("products").insert({
        "name": name, "category": category, "station": station, "department": department,
        "is_bundle": bundle, "active": active, "needs_station_review": False,
        "takeout_bowl_eligible": department == "kitchen" and "extra" not in category.casefold(),
    }).execute().data[0]
    size_row = sb.table("product_sizes").insert({"product_id": row["id"], "size_label": size, "price": price, "sort_order": 0}).execute().data[0]
    row["product_sizes"] = [size_row]
    products.append(row)
    by_name[name.casefold()] = row
    return row


def add_bundle(product: dict, size_label: str, pieces: int, draws_from: str) -> None:
    size = next((s for s in product.get("product_sizes", []) if s["size_label"] == size_label), None)
    if not size or str(size["id"]).startswith("dry-run:"):
        return
    existing_rows = sb.table("bundle_components").select("id,total_pieces,draws_from").eq("product_size_id", size["id"]).execute().data
    existing = existing_rows[0] if existing_rows else None
    values = {"total_pieces": pieces, "draws_from": draws_from, "allocation_method": "Kitchen confirms actual allocation during prep", "notes": "Updated from the October menu board."}
    if existing:
        if existing["total_pieces"] != pieces or existing["draws_from"] != draws_from:
            log(f"UPDATE BUNDLE {product['name']} {size_label}: {pieces} pieces from {draws_from}")
            if APPLY:
                sb.table("bundle_components").update(values).eq("id", existing["id"]).execute()
    else:
        log(f"ADD BUNDLE {product['name']} {size_label}: {pieces} pieces from {draws_from}")
        if APPLY:
            sb.table("bundle_components").insert({"product_size_id": size["id"], **values}).execute()


log("Shared menu catalog sync -- " + ("APPLY" if APPLY else "DRY RUN"))

# Remove the discontinued ₱299 cafe Latte from sale while retaining its history.
update_product("Latte", active=False)

# Normalize and publish the cafe drinks shown on the posted espresso menu.
choko_product = "Dako choco" if "dako choco" in by_name else "Daku Choko"
update_product(choko_product, name="Daku Choko", category="Cafe (16oz Iced)", department="cafe", station="cafe_bar")
if "daku choko" in by_name and "dako choco" in by_name and APPLY:
    by_name["daku choko"] = by_name.pop("dako choco")
for name, category in [
    ("Amerikano", "Cafe (16oz Iced)"),
    ("Caramel Macchiato (Kyarameru Makiato)", "Cafe (16oz Iced)"),
    ("Dark Mocha (Daku Moka)", "Cafe (16oz Iced)"),
    ("Spanish Latte (Supein Rate)", "Cafe (16oz Iced)"),
    ("Sea Salt Latte (Shi Soruto Rate)", "Cafe (16oz Iced)"),
    ("Tiramisu Rate", "Cafe (16oz Iced)"),
    ("Matcha Latte (Matcha Rate)", "Cafe (16oz Iced)"),
]:
    update_product(name, category=category, department="cafe", station="cafe_bar")

ensure_product("Ichigo Rate", "Cafe (16oz Iced)", 129, "16 oz", station="cafe_bar", department="cafe")
ensure_product("Itchigo Matcha", "Cafe (16oz Iced)", 199, "16 oz", station="cafe_bar", department="cafe")
ensure_product("Matcha Cream Puff", "Desserts", 49, "1 pc", station="cafe_bar", department="cafe")
ensure_product("Matcha Cheesecake", "Desserts", 0, "Price pending", station="cafe_bar", department="cafe", active=False)
update_product("Dubai Chewy Cookie", category="Desserts", department="cafe", station="cafe_bar")
update_product("Tiramisu Cake", category="Desserts", department="cafe", station="cafe_bar")

# Reuse existing POS add-on SKUs so historical entries and the new names
# continue to refer to the same product records.
for old_name, new_name, old_size in [
    ("Takoyaki sauce", "Takoyaki Sauce", "3oz"),
    ("Special sauce", "Special Oishii Nori Sauce", "Regular"),
]:
    source_name = old_name if old_name.casefold() in by_name else new_name
    row = update_product(source_name, name=new_name, category="Takoyaki Extras", department="kitchen", station="hot_line")
    if row:
        source_size = old_size if any(size["size_label"] == old_size for size in row["product_sizes"]) else "1 serving"
        update_size(row, source_size, new_label="1 serving")
        if APPLY:
            by_name.pop(old_name.casefold(), None)
            by_name[new_name.casefold()] = row

# Posted Drip Tea sizes use LD / HD / OD, in the same order as the existing
# Small / Medium / Large prices. The two mousse drinks remain available as
# requested, including the products marked unavailable on their posters.
for product in products:
    category = str(product.get("category", ""))
    if product.get("department") != "cafe" or (not category.casefold().startswith("drip tea") and category.casefold() != "thai series"):
        continue
    for old, new in (("Small", "LD"), ("Medium", "HD"), ("Large", "OD")):
        if any(size["size_label"] == old for size in product["product_sizes"]):
            update_size(product, old, new_label=new)
# The live catalog contains a legacy active kitchen duplicate for each mousse
# and a correctly categorized, inactive cafe record with the full size ladder.
# Keep the cafe records as the canonical online products and retire the
# duplicate from sale without deleting its transaction history.
for name, category in [
    ("Thai Black Mousse", "Drip Tea (Thai Series)"),
    ("Matcha Black Mousse", "Drip Tea (Matcha Series)"),
]:
    matches = [p for p in products if p["name"].casefold() == name.casefold()]
    canonical = next((p for p in matches if p.get("department") == "cafe"), None)
    if canonical:
        by_name[name.casefold()] = canonical
        for duplicate in matches:
            if duplicate["id"] != canonical["id"] and duplicate.get("active"):
                log(f"DEACTIVATE duplicate {duplicate['name']} ({duplicate['id']})")
                if APPLY:
                    sb.table("products").update({"active": False}).eq("id", duplicate["id"]).execute()
                duplicate["active"] = False
        update_product(canonical["name"], name=name, category=category, department="cafe", station="cafe_bar", active=True)
    else:
        update_product(name, name=name, category=category, department="cafe", station="cafe_bar", active=True)
for name, category, low, mid, high in [
    ("Thai Black Mousse", "Drip Tea (Thai Series)", 114, 124, 164),
    ("Matcha Black Mousse", "Drip Tea (Matcha Series)", 114, 124, 164),
]:
    ensure_product(name, category, low, "LD", station="cafe_bar", department="cafe")
    ensure_product(name, category, mid, "HD", station="cafe_bar", department="cafe")
    ensure_product(name, category, high, "OD", station="cafe_bar", department="cafe")

# Classic maki prices and piece labels already match the posted menu.
# Correct guest-facing headcounts on baked sushi, which were 6-8 in the POS.
for name in ("Baked Kani Sushi", "Oishii Baked Sushi", "Spicy Tuna Baked Sushi", "Cheesy Baked Spicy Scallop", "Baked Salmon Teriyaki"):
    row = by_name.get(name.casefold())
    if row:
        for size in row["product_sizes"]:
            label = size["size_label"]
            target = label.replace("Large (6–8 pax)", "Large (5–6 pax)").replace("Large (6-8 pax)", "Large (5–6 pax)")
            if target != label:
                update_size(row, label, new_label=target)

# Refresh the boat piece counts/prices and add the 124-piece large size.
for name, label, pcs, amount in [
    ("Small Sushi Boat", "32 pcs, classic maki flavors", 32, 1199),
    ("Medium Sushi Boat", "64 pcs, classic maki flavors", 64, 1999),
]:
    row = by_name.get(name.casefold())
    if row:
        old = row["product_sizes"][0]["size_label"]
        update_size(row, old, new_label=label, price=amount, deposit=1000)
        if APPLY:
            row["product_sizes"][0].update({"size_label": label, "price": amount, "deposit_amount": 1000})
        add_bundle(row, label, pcs, "Oishii Nori classic maki flavors")
large_boat = ensure_product("Large Sushi Boat", "Maki & Gyoza Platters (Bundle)", 3499, "124 pcs, classic maki flavors", station="sushi_bar", bundle=True)
if large_boat.get("id", "").startswith("dry-run:"):
    pass
elif APPLY:
    size = large_boat["product_sizes"][0]
    sb.table("product_sizes").update({"deposit_amount": 2500}).eq("id", size["id"]).execute()
    size["deposit_amount"] = 2500
add_bundle(large_boat, "124 pcs, classic maki flavors", 124, "Oishii Nori classic maki flavors")

# Sushi platters and side items shown on the posted boards.
california_platter = ensure_product("California Platter", "Oishii Platter (Bundle)", 799, "32 pcs", station="sushi_bar", bundle=True)
add_bundle(california_platter, "32 pcs", 32, "California Maki catalog")
ensure_product("Kani Salad Platter", "Oishii Salad", 999, "4–6 pax", station="salad_cold_bar")
ensure_product("Gyoza (3 pcs)", "Sides", 99, "3 pcs", station="hot_line")
five_piece_gyoza = "5pc Gyoza" if "5pc gyoza" in by_name else "Gyoza (5 pcs)"
update_product(five_piece_gyoza, name="Gyoza (5 pcs)", category="Sides", department="kitchen", station="hot_line")
ensure_product("Torched Cheesy Gyoza", "Sides", 199, "1 serving", station="sushi_bar_oven")

# Menu-board extras, entered as shared catalog items so POS and online prices agree.
for name, price, size, category, station in [
    ("Salted Nori", 38, "1 pack", "Baked Sushi Extras", "sushi_bar_oven"),
    ("Chopstick", 2, "1 pair", "Baked Sushi Extras", "sushi_bar_oven"),
    ("Japanese Mayo", 30, "1 serving", "Baked Sushi Extras", "sushi_bar_oven"),
    ("Baked Sushi Special Sauce", 50, "1 serving", "Baked Sushi Extras", "sushi_bar_oven"),
    ("Bonito Flakes", 20, "1 serving", "Takoyaki Extras", "hot_line"),
    ("Cheese Cuts (4)", 15, "4 pcs", "Takoyaki Extras", "hot_line"),
    ("Special Cheese Sauce", 30, "1 serving", "Takoyaki Extras", "hot_line"),
    ("Cheddar Cheese", 20, "1 serving", "Takoyaki Extras", "hot_line"),
    ("Pork Floss", 20, "1 serving", "Takoyaki Extras", "hot_line"),
]:
    ensure_product(name, category, price, size, station=station)

log("\nDone. This sync does not deactivate any other active item absent from the posters.")
