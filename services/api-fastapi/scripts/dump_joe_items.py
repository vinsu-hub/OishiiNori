"""Read-only: every active ingredient and unlinked station item with its
station, section, main unit, sizes and stock -- to match Sir Joe's per-station
count lists (2026-11-20) to real items before apply_joe_count_units.py.

    cd services/api-fastapi && .venv/bin/python scripts/dump_joe_items.py [filter]
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def main() -> int:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase

    flt = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    db = get_supabase()
    ings = db.table("ingredients").select(
        "id, name, base_unit, station, sheet_section, sort_order, current_stock, prep_yield, active"
    ).execute().data
    items = db.table("stock_items").select("id, name, station, category, unit, ingredient_id, sort_order, current_stock, active").execute().data
    units = db.table("item_units").select("ingredient_id, stock_item_id, name, base_qty").execute().data
    sizes: dict[str, list[str]] = {}
    for u in units:
        key = u["ingredient_id"] or u["stock_item_id"]
        sizes.setdefault(key, []).append(f"{u['name']}={float(u['base_qty']):g}")
    links: dict[str, list[str]] = {}
    for s in items:
        if s["ingredient_id"]:
            links.setdefault(s["ingredient_id"], []).append(f"{s['station']}:{s['name']}")

    rows = []
    for i in ings:
        if i.get("active") is False:
            continue
        rows.append((i["station"] or "~unsorted", i["sheet_section"] or "", i["sort_order"] or 0, "I", i["name"], i["base_unit"],
                     sizes.get(i["id"], []), float(i["current_stock"] or 0),
                     ("base" if i.get("prep_yield") is not None else "") + (f" linked:{links[i['id']]}" if i["id"] in links else "")))
    for s in items:
        if s["ingredient_id"] or s.get("active") is False:
            continue
        rows.append((s["station"], s["category"] or "", s["sort_order"] or 0, "S", s["name"], s["unit"] or "pcs",
                     sizes.get(s["id"], []), float(s["current_stock"] or 0), ""))
    rows.sort(key=lambda r: (r[0], r[1], r[2], r[4]))
    for st, sec, _o, kind, name, unit, sz, stock, extra in rows:
        line = f"{st:18} | {sec[:22]:22} | {kind} | {name[:38]:38} | {unit:7} | {', '.join(sz)[:40]:40} | {stock:g} {extra}"
        if flt in line.lower():
            print(line)
    print(f"\n{len(rows)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
