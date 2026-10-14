"""
Floor plan v3 (2026-10-14): 17 tables, matching the POS's 1-17 choices.
Builds on seed_floor_plan_v2.py's 12 tables; numbers 1-12 keep their
printed QR stickers.

  1      the long counter table split in two: Table 1 keeps its spot
  13     ...and its other half, right beside it (both 2-seaters)
  14     a second small round 2-top, beside Table 2
  15-17  new 2-tops, placed in a strip below the dining room

Only Table 1 changes among the existing rows. Tables 13-17 are flagged
needs_layout_review, so the Floor Plan marks them until a manager drags each
into its real spot (and fixes seats in the Tables tab if needed).

Positions are canvas coordinates as stored (DiningRoomBackdrop's offset is
already applied, unlike v2's mockup centres). Matched by pos_table_number;
nothing is deleted. Idempotent: an existing 13-17 is left where it is, so a
re-run never undoes a manager's drag.

Run with:  .venv/bin/python scripts/seed_floor_plan_v3.py           # dry run
           .venv/bin/python scripts/seed_floor_plan_v3.py --apply
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
ZONE = "Dining Room"

# number, shape, top-left (x, y), size (w, h), capacity (min, max)
TABLE_1 = (1, "square", (191, 589), (104, 92), (2, 2))
NEW_TABLES = [
    (13, "square", (307, 589), (104, 92), (2, 2)),
    (14, "round", (637, 592), (104, 104), (2, 2)),
    (15, "square", (80, 1310), (104, 92), (2, 2)),
    (16, "square", (200, 1310), (104, 92), (2, 2)),
    (17, "square", (320, 1310), (104, 92), (2, 2)),
]


def desired(number, shape, pos, size, capacity, review) -> dict:
    (x, y), (w, h), (lo, hi) = pos, size, capacity
    return {
        "label": f"Table {number}",
        "pos_table_number": number,
        "floor_group": ZONE,
        "shape": shape,
        "pos_x": x,
        "pos_y": y,
        "width": w,
        "height": h,
        "capacity": hi,
        "capacity_min": lo,
        "capacity_max": hi,
        "active": True,
        "needs_layout_review": review,
    }


def main() -> None:
    apply = "--apply" in sys.argv
    rows = requests.get(f"{URL}/tables?select=*", headers=HEADERS, timeout=30).json()
    by_number = {r["pos_table_number"]: r for r in rows if r.get("pos_table_number") is not None}

    table_1 = by_number.get(1)
    if table_1 is None:
        sys.exit("Table 1 not found -- run seed_floor_plan_v2.py first")
    want = desired(*TABLE_1, review=False)
    changes = {k: v for k, v in want.items() if table_1.get(k) != v}
    print(f"~ Table 1 -> 2-seater ({', '.join(changes) or 'already up to date'})")
    if apply and changes:
        requests.patch(f"{URL}/tables?id=eq.{table_1['id']}", headers=HEADERS, json=changes, timeout=30).raise_for_status()

    big = requests.get(
        f"{URL}/reservations?select=reservation_number,customer_name,reservation_date,party_size"
        f"&table_id=eq.{table_1['id']}&status=in.(pending,confirmed)&party_size=gt.2",
        headers=HEADERS, timeout=30,
    ).json()
    for res in big:
        print(f"! reservation #{res['reservation_number']} ({res['customer_name']}, {res['reservation_date']}, "
              f"party of {res['party_size']}) is on Table 1 -- move it or seat them at 1 + 13")

    for spec in NEW_TABLES:
        row = desired(*spec, review=True)
        if spec[0] in by_number:
            print(f"= {row['label']} already exists -- left as is")
            continue
        print(f"+ create {row['label']} ({row['shape']}, {row['capacity']} seats, needs layout review)")
        if apply:
            requests.post(f"{URL}/tables", headers=HEADERS, json=row, timeout=30).raise_for_status()

    print("\nApplied." if apply else "\nDry run only -- re-run with --apply to write.")


if __name__ == "__main__":
    main()
