"""One-time seed: creates one stock_items row per line item on the client's
real physical stock transcription (D:\\ioshinori\\Oishii_Nori_Physical_Stock_
Transcription.xlsx), station-tagged, needs_review=true where the sheet's
own Verify column says VERIFY.

Auto-links to an existing `ingredients` row ONLY on an exact (case-
insensitive) name match or a tiny curated alias list -- never by fuzzy/
similarity matching, per the explicit "don't guess mismatches" decision.
Chiller/freezer storage-split pairs are never auto-linked even on an exact
base-name match, since ingredients.current_stock is a single running total
with no per-location split (linking either half would let one location's
count silently overwrite the other's).

No count figures (New Stocks/Beginning/Usage/Ending) are imported -- the
sheet's own quantities are non-standardized shorthand the cover sheet warns
against trusting for system seeding. The catalog is created empty of
history; real counting starts fresh through the new Stock Count UI.

Disposable, not meant to be rerun once applied -- idempotent via the
(station, name) unique constraint (skips a row if it already exists).
Uses the stdlib zipfile/XML approach (no openpyxl in this venv) rather than
adding a new dependency for a one-off script.
"""

import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

XLSX_PATH = r"D:\ioshinori\Oishii_Nori_Physical_Stock_Transcription.xlsx"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

STATION_MAP = {
    "1. Tako-Snack Station": "tako_snack",
    "2. Cafe-Drinks Station": "cafe_drinks",
    "3. Sushi-Kitchen Main": "sushi_kitchen_main",
    "4. Ramen-Hot Line": "ramen_hot_line",
}

# Unambiguous literal/parenthetical translations only -- see module docstring.
ALIAS_MAP = {
    "japanese rice (raw)": "Sushi rice (raw)",
    "pipino (cucumber)": "Cucumber",
    "tahong (mussels)": "Mussels",
}


def _col_to_num(col: str) -> int:
    n = 0
    for c in col:
        n = n * 26 + (ord(c) - ord("A") + 1)
    return n


def _cell_ref_col(ref: str) -> tuple[str, int]:
    m = re.match(r"([A-Z]+)(\d+)", ref)
    return m.group(1), int(m.group(2))


def _read_workbook(path: str) -> dict[str, list[list]]:
    z = zipfile.ZipFile(path)
    wb_xml = ET.fromstring(z.read("xl/workbook.xml"))
    sheets = [
        (s.get("name"), s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"))
        for s in wb_xml.find(f"{NS}sheets")
    ]
    rels_xml = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {rel.get("Id"): rel.get("Target") for rel in rels_xml}

    shared_strings = []
    try:
        ss_xml = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in ss_xml.findall(f"{NS}si"):
            shared_strings.append("".join(t.text or "" for t in si.findall(f".//{NS}t")))
    except KeyError:
        pass

    def get_cell_value(c):
        t = c.get("t")
        v_el = c.find(f"{NS}v")
        if v_el is None:
            is_el = c.find(f"{NS}is")
            if is_el is not None:
                return "".join(t2.text or "" for t2 in is_el.findall(f".//{NS}t"))
            return None
        v = v_el.text
        return shared_strings[int(v)] if t == "s" else v

    def read_sheet(target):
        xml = ET.fromstring(z.read(f"xl/{target}"))
        rows_out = []
        for row in xml.find(f"{NS}sheetData").findall(f"{NS}row"):
            row_cells = {}
            for c in row.findall(f"{NS}c"):
                col, _ = _cell_ref_col(c.get("r"))
                row_cells[_col_to_num(col)] = get_cell_value(c)
            max_col = max(row_cells.keys()) if row_cells else 0
            rows_out.append([row_cells.get(i, "") for i in range(1, max_col + 1)])
        return rows_out

    return {name: read_sheet(rid_to_target[rid]) for name, rid in sheets}


def main():
    supabase = get_supabase()

    ingredients = supabase.table("ingredients").select("id, name").execute().data
    ingredients_by_lower = {i["name"].strip().lower(): i for i in ingredients}

    sheets = _read_workbook(XLSX_PATH)

    existing_items = supabase.table("stock_items").select("station, name").execute().data
    existing_keys = {(i["station"], i["name"]) for i in existing_items}

    exact_matches = []
    alias_matches = []
    unlinked = []
    verify_count = 0
    total_rows = 0
    skipped_existing = 0

    to_insert = []

    for sheet_name, station in STATION_MAP.items():
        rows = sheets[sheet_name]
        for row in rows[3:]:  # skip title/subtitle/header rows
            if not row or not row[0]:
                continue
            name = str(row[0]).strip()
            verify_flag = len(row) > 6 and str(row[6]).strip().upper() == "VERIFY"
            total_rows += 1
            if verify_flag:
                verify_count += 1

            if (station, name) in existing_keys:
                skipped_existing += 1
                continue

            name_lower = name.lower()
            ingredient_id = None
            if "chiller" in name_lower or "freezer" in name_lower:
                pass  # never auto-link storage-split pairs
            elif name_lower in ingredients_by_lower:
                match = ingredients_by_lower[name_lower]
                ingredient_id = match["id"]
                exact_matches.append((name, station, match["name"]))
            elif name_lower in ALIAS_MAP:
                target_name = ALIAS_MAP[name_lower]
                match = next((i for i in ingredients if i["name"] == target_name), None)
                if match:
                    ingredient_id = match["id"]
                    alias_matches.append((name, station, match["name"]))

            if ingredient_id is None:
                unlinked.append((name, station))

            to_insert.append(
                {
                    "name": name,
                    "station": station,
                    "ingredient_id": ingredient_id,
                    "needs_review": verify_flag,
                }
            )

    if to_insert:
        # Insert one at a time to tolerate a partial prior run without
        # aborting the whole batch on a unique-constraint hit.
        inserted = 0
        for item in to_insert:
            try:
                supabase.table("stock_items").insert(item).execute()
                inserted += 1
            except Exception as e:
                print(f"  SKIP (insert failed) {item['station']}/{item['name']}: {e}")
        print(f"Inserted {inserted} new stock_items rows.\n")
    else:
        print("No new rows to insert (all already exist).\n")

    print(f"{total_rows} sheet rows processed ({skipped_existing} already existed, skipped)")
    print(f"{len(exact_matches)} auto-linked on exact name match:")
    for name, station, matched in exact_matches:
        print(f"  - {name} ({station}) -> {matched}")
    print(f"{len(alias_matches)} auto-linked via curated alias:")
    for name, station, matched in alias_matches:
        print(f"  - {name} ({station}) -> {matched}")
    print(f"{verify_count} rows flagged needs_review=true (sheet's VERIFY column)")
    print(f"{len(unlinked)} rows created standalone, no ingredient link")

    print("""
KNOWN AMBIGUOUS GROUPS -- NOT auto-linked, needs a human decision via Manage Stock Items:
1. Nori variants (sushi_kitchen_main): Nori Whole, Nori Half, Salted Nori, Ramen Nori
   vs. single ingredient "Nori sheet"
2. Mayo variants: Mayo (tako_snack, VERIFY), Mayo (sushi_kitchen_main), Hot Mayo (sushi_kitchen_main)
   vs. 3 ingredients: Special mayo (house), Spicy mayo, Tartar/mayo sauce
3. No ingredient-table counterpart at all: Kikkoman Bottle Small/Large, Kikkoman (soy sauce),
   Kikkoman Mix, Wasabi, Wasabi Mix, Curry
4. Chiller/Freezer storage-split pairs (never auto-linked even on exact base-name match):
   Octo Bits, Crabstick, Chick Nuggets, Bacon (tako_snack); Breaded Prawns, Breaded Chicken,
   Tuna, Salmon, Scallop, Crab, Ebiko (sushi_kitchen_main); Beef Sliced, Tonkatsu, Torikatsu
   (ramen_hot_line); Full Cream, Nestle Cream (cafe_drinks)
5. Rice ambiguity: Japanese Rice (cooked), Reg. Rice (raw), Rice Cooked -- two candidate
   ingredients (Sushi rice (raw), Steamed rice), genuinely unclear which sheet row feeds which
6. Tuna ambiguity: Tuna (tako_snack), Tuna Chiller/Freezer + Spicy Tuna Mix (sushi_kitchen_main)
   vs. 2 ingredients: Tuna (raw, spicy tuna mix), Canned tuna
7. Near-miss names one word short of exact -- confirm and link manually via the catalog UI:
   Mozzarella vs "Mozzarella cheese", Parmesan vs "Parmesan cheese", Shrimp vs "Shrimp / Prawn (raw)",
   Angus Beef vs "Angus beef (sliced)"
""")


if __name__ == "__main__":
    main()
