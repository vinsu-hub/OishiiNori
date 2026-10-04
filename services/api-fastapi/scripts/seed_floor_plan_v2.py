"""
Re-seed the tables registry from the client's traced floor plan (Floor
plan-html.zip -> Main.dc.html, 2026-10-04). Replaces seed_floor_plan.py's
photo-based guess: 12 tables, numbered 1-12, all in one "Dining Room" zone
that dashboard-web's DiningRoomBackdrop draws the walls/counter/entrance for.

Numbering (confirmed with the client):
  1      long table by the counter
  2      small round table by the wall
  3-5    dining row 1: 2-top, 4-top, 2-top (left -> right)
  6-8    dining row 2: 2-top, 4-top, 2-top
  9-10   window marble-top 2-tops
  11-12  bench tables in the side annex (top, bottom)

Positions are each table's centre in the mockup, offset by (-60, -140) so
the canvas starts at the room's top-left -- the same offset
DiningRoomBackdrop.tsx uses -- with the table sized to what FloorPlanPanel
actually renders (its renderSize() minimums), so DB and screen agree.

Existing rows are updated in place, matched by pos_table_number 1..12:
reservations reference tables (FK on delete restrict), so nothing is
deleted. Idempotent.

Run with:  .venv/bin/python scripts/seed_floor_plan_v2.py           # dry run
           .venv/bin/python scripts/seed_floor_plan_v2.py --apply
"""
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

URL = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY = os.environ["SUPABASE_SECRET_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

OFFSET_X, OFFSET_Y = 60, 140
ZONE = "Dining Room"

# number, shape, mockup centre (x, y), rendered size (w, h), capacity (min, max)
TABLES = [
    (1, "rectangle", (332, 775), (162, 94), (5, 6)),
    (2, "round", (629, 784), (104, 104), (2, 2)),
    (3, "square", (191.5, 972.5), (104, 92), (2, 2)),
    (4, "rectangle", (404, 970.5), (148, 93), (4, 4)),
    (5, "square", (625, 968.5), (104, 92), (2, 2)),
    (6, "square", (191.5, 1215), (104, 98), (2, 2)),
    (7, "rectangle", (410.5, 1200), (148, 110), (4, 4)),
    (8, "square", (623, 1179), (104, 92), (2, 2)),
    (9, "square", (430, 1372), (104, 92), (2, 2)),
    (10, "square", (614.5, 1357), (104, 92), (2, 2)),
    (11, "rectangle", (779.5, 405.5), (175, 92), (4, 6)),
    (12, "rectangle", (779.5, 632.5), (175, 97), (4, 6)),
]


def desired(number, shape, centre, size, capacity) -> dict:
    (cx, cy), (w, h), (lo, hi) = centre, size, capacity
    return {
        "label": f"Table {number}",
        "pos_table_number": number,
        "floor_group": ZONE,
        "shape": shape,
        "pos_x": round(cx - w / 2 - OFFSET_X),
        "pos_y": round(cy - h / 2 - OFFSET_Y),
        "width": w,
        "height": h,
        "capacity": hi,
        "capacity_min": lo,
        "capacity_max": hi,
        "active": True,
        "needs_layout_review": False,
    }


def main() -> None:
    apply = "--apply" in sys.argv
    rows = requests.get(f"{URL}/tables?select=*", headers=HEADERS, timeout=30).json()
    by_number = {r["pos_table_number"]: r for r in rows if r.get("pos_table_number") is not None}
    label_by_id = {r["id"]: r["label"] for r in rows}

    # tables.label is unique and the old names overlap the new ones ("Booth 1"
    # -> "Table 1" while another row is still "Table 1"), so move every row
    # that's being renamed to a temporary label first.
    renaming = [
        by_number[t[0]] for t in TABLES if t[0] in by_number and by_number[t[0]]["label"] != f"Table {t[0]}"
    ]
    if apply:
        for row in renaming:
            tmp = f"__renaming {row['id']}"
            r = requests.patch(f"{URL}/tables?id=eq.{row['id']}", headers=HEADERS, json={"label": tmp}, timeout=30)
            r.raise_for_status()
            row["label"] = tmp

    for spec in TABLES:
        want = desired(*spec)
        current = by_number.get(want["pos_table_number"])
        if current is None:
            print(f"+ create {want['label']}")
            if apply:
                r = requests.post(f"{URL}/tables", headers=HEADERS, json=want, timeout=30)
                r.raise_for_status()
            continue
        changes = {k: v for k, v in want.items() if current.get(k) != v}
        if not changes:
            print(f"= {want['label']} already up to date")
            continue
        print(f"~ #{want['pos_table_number']} '{label_by_id[current['id']]}' -> '{want['label']}' ({', '.join(changes)})")
        if apply:
            r = requests.patch(f"{URL}/tables?id=eq.{current['id']}", headers=HEADERS, json=changes, timeout=30)
            r.raise_for_status()

    extra = [r for r in rows if r.get("pos_table_number") not in {t[0] for t in TABLES} and r.get("active")]
    for r in extra:
        print(f"! active table '{r['label']}' (pos #{r.get('pos_table_number')}) is not in the new plan -- left as is")

    # Reservations stay on the same physical row; show them under the new names.
    new_label = {by_number[t[0]]["id"]: f"Table {t[0]}" for t in TABLES if t[0] in by_number}
    upcoming = requests.get(
        f"{URL}/reservations?select=reservation_number,customer_name,reservation_date,table_id,status"
        "&status=in.(pending,confirmed)&table_id=not.is.null",
        headers=HEADERS,
        timeout=30,
    ).json()
    if upcoming:
        print("\nActive reservations (same table row, new name):")
        for res in upcoming:
            tid = res["table_id"]
            print(
                f"  #{res['reservation_number']} {res['customer_name']} {res['reservation_date']}: "
                f"'{label_by_id.get(tid)}' -> '{new_label.get(tid, label_by_id.get(tid))}'"
            )

    print("\nApplied." if apply else "\nDry run only -- re-run with --apply to write.")


if __name__ == "__main__":
    main()
