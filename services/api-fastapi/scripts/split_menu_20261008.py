"""Stage separate meat products and add Tiramisu Rate; dry-run by default.

--apply creates/activates the seven new entities without recipes or stock writes.
--retire-combined requires --apply AND deployment of inactive-catalog lookups
in KDS/Order Queue/Delivery/bridge first. Original IDs and history are retained.
"""
import argparse
import sys
from pathlib import Path
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.deps import get_supabase

SOURCE_NAMES = ["Katsudon Curry (Pork or Chicken)", "Cheesy Katsu oBento (Pork or Chicken)", "Katsu oBento (Pork or Chicken)"]
FIELDS = ("category", "station", "department", "is_bundle", "image_path")
SIZE_FIELDS = ("size_label", "price", "scale_factor", "sort_order")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--retire-combined", action="store_true")
    args = parser.parse_args()
    if args.retire_combined and not args.apply:
        parser.error("--retire-combined requires --apply")
    db = get_supabase()
    catalog = db.table("products").select("*,product_sizes(*)").execute().data
    by_name = {p["name"].strip().casefold(): p for p in catalog}
    sources = [by_name[name.casefold()] for name in SOURCE_NAMES]
    size_ids = [s["id"] for p in sources for s in p["product_sizes"]]
    if db.table("recipe_items").select("id").in_("product_size_id", size_ids).execute().data:
        raise RuntimeError("Combined products now have recipes; review meat-specific recipes before splitting")
    if db.table("stock_consumption_rules").select("id").in_("product_size_id", size_ids).execute().data:
        raise RuntimeError("Combined products have stock rules; explicitly review before splitting")
    planned = []
    for source in sources:
        for meat in ("Pork", "Chicken"):
            name = source["name"].replace("Pork or Chicken", meat)
            planned.append(({"name": name, **{k: source[k] for k in FIELDS}}, [{k:s[k] for k in SIZE_FIELDS} for s in source["product_sizes"]]))
    planned.append(({"name":"Tiramisu Rate", "category":"Cafe (16oz Iced)", "station":"cafe_bar", "department":"cafe", "is_bundle":False, "image_path":None}, [{"size_label":"16 oz", "price":229, "scale_factor":1, "sort_order":0}]))
    # Check every existing target before performing any writes. Re-runs resume
    # an inactive product created before a failed size insert, never overwrite.
    for product, sizes in planned:
        old = by_name.get(product["name"].casefold())
        if old:
            if any(old[k] != product[k] for k in FIELDS):
                raise RuntimeError(f"Existing {product['name']} differs; review manually")
            actual = sorted([{k:s[k] for k in SIZE_FIELDS} for s in old["product_sizes"]], key=lambda s:s['size_label'])
            if actual and actual != sorted(sizes,key=lambda s:s['size_label']):
                raise RuntimeError(f"Existing sizes/prices differ for {product['name']}")
        print(product['name'], product['category'], [(s['size_label'],s['price']) for s in sizes])
    if not args.apply:
        print('Dry run. No changes.'); return
    for product, sizes in planned:
        old = by_name.get(product["name"].casefold())
        if not old:
            old = db.table('products').insert({**product,'active':False}).execute().data[0]
            old['product_sizes'] = []
        if not old['product_sizes']:
            db.table('product_sizes').insert([{**s,'product_id':old['id']} for s in sizes]).execute()
        if not old['active']:
            db.table('products').update({'active':True}).eq('id',old['id']).execute()
        print('Active:',product['name'])
    if args.retire_combined:
        db.table('products').update({'active':False}).in_('id',[p['id'] for p in sources]).execute()
        print('Combined originals deactivated; IDs and sales history retained.')
    else:
        print('Combined originals retained until inactive-catalog lookup fix is deployed; then use --retire-combined.')
    from app.routers.products import _list_products_data
    current = {p['name']: p for p in _list_products_data(db, True, None)}
    for product, sizes in planned:
        saved = current[product['name']]
        assert all(s['availability'] == 'available' for s in saved['sizes'])
        assert sorted((s['size_label'],s['price']) for s in saved['sizes']) == sorted((s['size_label'],s['price']) for s in sizes)
        assert not db.table('recipe_items').select('id').in_('product_size_id',[s['id'] for s in saved['sizes']]).execute().data
        print('Verified available, recipe-free:',product['name'])
    response = httpx.get('https://www.oishiinori.com/api/public/menu',timeout=30)
    response.raise_for_status()
    for product, _ in planned:
        assert product['name'] in response.text, f"Not yet visible in public catalog: {product['name']}"
    print('Live menu endpoint verified all seven new product names.')


if __name__ == '__main__': main()
