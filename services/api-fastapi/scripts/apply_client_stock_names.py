"""Apply the client's raw-material names (INVENTORY COFFEE GRIND.xlsx) to Station Items.

Each sheet is one stock station. Items keep their id, so counts, history and
recipe links stay; only the name changes. Items not on the client's list are
kept. Units and pack sizes are filled in where the sheet gives them and the
item has none yet. Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_client_stock_names.py "~/Downloads/INVENTORY COFFEE GRIND(1).xlsx"
    ... --apply
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

SHEETS = {
    "RAMEN": "ramen_hot_line",
    "MAKI": "sushi_kitchen_main",
    "DRIPTEASTACRUZ": "cafe_drinks",
    "TAKOSTACRUZ": "tako_snack",
}

# Our current name -> the client's name, per station (spelling variants).
RENAMES = {
    "ramen_hot_line": {
        "Tahong (Mussels)": "Tahong", "Onion Leeks": "Onion leaks", "Reg. Rice (raw)": "Reg. rice",
        "Bread Crumbs": "B.Crubms", "Tiny (bag)": "Tiny",
    },
    "sushi_kitchen_main": {
        "Small Platter": "Sml Platter", "Medium Platter": "Med platter", "Large Platter": "Lrg platter",
        "Small Pan": "Sml pan", "Medium Pan": "Med Pan", "Large Pan": "Lrg Pan",
        "Kikkoman Bottle Small": "Kikkobottle SMALL", "Kikkoman Bottle Large": "Kikkobottle Large",
        "Mozzarella": "Mozarella", "Tonkatsu Sauce": "Tongkatsu sauce", "Yakiniku Sauce": "Yakiniku",
        "Sriracha": "Schiracha", "Kikkoman (soy sauce)": "Kikoman", "Kikkoman Mix": "Kikoman mix",
        "Japanese Rice (raw)": "Japanese Rice", "Japanese Rice (cooked)": "J Rice cooked",
        "Pipino (Cucumber)": "Pipino", "Tanuki (tempura bits)": "Tanuki",
        "Kani (crab stick, prepped)": "Kani", "Butane (gas canister)": "Butane",
    },
    "cafe_drinks": {
        "LD (large lid?)": "LD", "HD (small lid?)": "HD", "OD (cup)": "OD", "Nutella": "Nuttela",
        "WM (whole milk?)": "WM", "Matcha (Rate/syrup)": "Matcha Rate",
        "Butterfly (pea flower)": "Butterfly", "Condensed Milk": "Condensed",
    },
    "tako_snack": {
        "Repolyo (cabbage)": "Repolyo", "Octo Bits Chiller": "Octo bits", "Crabstick Chiller": "Crabstick",
    },
}

UNIT_WORDS = {"pcs": "pcs", "pc": "pcs", "grams": "grams", "gram": "grams", "g": "grams",
              "kg": "kg", "liter": "liter", "liters": "liter", "pack": "pack", "packs": "pack"}
TO_BASE = {("kg", "grams"): 1000, ("grams", "grams"): 1, ("pcs", "pcs"): 1, ("liter", "liter"): 1}
PACK_RE = re.compile(r"^\s*([\d.]+)\s*([a-z]+)\s+per\s+(pack|bottle)\s*$", re.I)


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def unit_word(cell) -> str | None:
    return UNIT_WORDS.get(str(cell).strip().lower()) if cell else None


def read_sheets(path: str) -> dict[str, list[dict]]:
    """station -> [{name, unit, pack: (unit_name, base_qty) | None}] in sheet order."""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    out: dict[str, list[dict]] = {}
    for ws in wb.worksheets:
        station = SHEETS.get(ws.title.strip().upper())
        if not station:
            print(f"!! sheet {ws.title!r} has no station; skipped")
            continue
        rows = []
        for cells in ws.iter_rows(values_only=True):
            name = str(cells[0]).strip() if cells and cells[0] else ""
            if not name or name.upper() in ("NEW STOCKS",):
                continue
            extra = [c for c in cells[1:] if c not in (None, "", "+") and not str(c).startswith("#")]
            unit = pack = None
            if station == "cafe_drinks":
                # Column 2 describes the pack, column 3 is the counting unit.
                unit = unit_word(cells[2] if len(cells) > 2 else None) or unit_word(cells[1])
                match = PACK_RE.match(str(cells[1] or ""))
                if match and unit:
                    qty, src, holder = float(match[1]), unit_word(match[2]), match[3].lower()
                    factor = TO_BASE.get((src, unit))
                    if factor:
                        pack = (holder, qty * factor)
            elif station == "tako_snack":
                unit = unit_word(cells[1])
            rows.append({"name": name, "unit": unit, "pack": pack, "extra": extra})
        out[station] = rows
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("xlsx")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from app.deps import get_supabase
    db = get_supabase()
    sheets = read_sheets(os.path.expanduser(args.xlsx))
    changes = 0
    for station, rows in sheets.items():
        items = db.table("stock_items").select("id,name,unit,active").eq("station", station).execute().data
        by_name = {norm(i["name"]): i for i in items}
        renames = {norm(old): new for old, new in RENAMES[station].items()}
        units = {u["stock_item_id"]: u for u in db.table("item_units").select("stock_item_id,name")
                 .in_("stock_item_id", [i["id"] for i in items]).execute().data} if items else {}
        print(f"\n== {station}: {len(rows)} names on the client's sheet")
        for row in rows:
            target = norm(row["name"])
            item = by_name.get(target)
            if not item:
                old = next((by_name[k] for k, new in renames.items() if norm(new) == target and k in by_name), None)
                if old:
                    print(f"  rename  {old['name']!r} -> {row['name']!r}")
                    changes += 1
                    if args.apply:
                        db.table("stock_items").update({"name": row["name"]}).eq("id", old["id"]).execute()
                    item = {**old, "name": row["name"]}
                else:
                    print(f"  add     {row['name']!r}" + (f" ({row['unit']})" if row["unit"] else ""))
                    changes += 1
                    if args.apply:
                        item = db.table("stock_items").insert({
                            "name": row["name"], "station": station, "unit": row["unit"], "needs_review": False,
                        }).execute().data[0]
                    else:
                        continue
                by_name[target] = item
            if item.get("name") != row["name"] and norm(item["name"]) == target and item["name"].strip() != row["name"]:
                # Same letters, different spacing/case: use the client's spelling.
                print(f"  respell {item['name']!r} -> {row['name']!r}")
                changes += 1
                if args.apply:
                    db.table("stock_items").update({"name": row["name"]}).eq("id", item["id"]).execute()
            if row["unit"] and not item.get("unit"):
                print(f"  unit    {row['name']!r}: {row['unit']}")
                changes += 1
                if args.apply:
                    db.table("stock_items").update({"unit": row["unit"]}).eq("id", item["id"]).execute()
            if row["pack"] and item["id"] not in units:
                name, qty = row["pack"]
                if name != (row["unit"] or ""):
                    print(f"  pack    {row['name']!r}: 1 {name} = {qty:g} {row['unit']}")
                    changes += 1
                    if args.apply:
                        db.table("item_units").insert({"stock_item_id": item["id"], "name": name, "base_qty": qty}).execute()
    print(f"\n{changes} change(s)." + ("" if args.apply else " Dry run; re-run with --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
