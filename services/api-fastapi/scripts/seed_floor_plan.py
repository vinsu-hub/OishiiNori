"""
Seed the tables registry with Oishii Nori's real dining room, from the two
on-site photos in D:\\ioshinori\\reference (tables 1.png = Booth Row along the
brick wall, tables 2.png = Main Dining open floor) and the layout doc's zone
estimate.

PHOTO-BASED ESTIMATE, not a verified count -- every row is left with
needs_layout_review = true. A manager must walk the room with the floor-plan
editor open and correct positions, exact capacity, and the round table.

Layout (canvas is 1000 x 680 units):

  Booth Row (bench seating, brick wall) -- rectangles across the top:
    Booth 1  pos#1  seats 4-6
    Booth 2  pos#2  seats 4-6
    Booth 3  pos#3  seats 4-6
    Booth 4  pos#4  seats 4      (back booth, fixed chairs not a bench)

  Main Dining (open floor):
    Table 1  pos#5  seats 4      wood 4-top
    Table 2  pos#6  seats 4      wood 4-top
    Table 3  pos#7  seats 4      wood 4-top
    Table 4  pos#8  seats 2      small square 2-top
    Table 5  pos#9  seats 2      small square 2-top
    Table 6  pos#10 seats 2      small square 2-top
    Table 7  pos#11 seats 2      small square 2-top
    Round 1  pos#12 seats 4      round table, capacity UNCONFIRMED in photo

Existing rows have reservations pointing at them (FK on delete restrict), so
this repurposes them in place by label rather than deleting. Idempotent:
re-running just re-applies the same values.

Run with:  .venv/Scripts/python.exe scripts/seed_floor_plan.py
"""
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

admin = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])

# label -> full desired row
LAYOUT: list[dict] = [
    # Booth Row
    dict(label="Booth 1", floor_group="Booth Row", shape="rectangle", pos_x=40, pos_y=50, width=210, height=90,
         pos_table_number=1, capacity_min=4, capacity_max=6),
    dict(label="Booth 2", floor_group="Booth Row", shape="rectangle", pos_x=290, pos_y=50, width=210, height=90,
         pos_table_number=2, capacity_min=4, capacity_max=6),
    dict(label="Booth 3", floor_group="Booth Row", shape="rectangle", pos_x=540, pos_y=50, width=210, height=90,
         pos_table_number=3, capacity_min=4, capacity_max=6),
    dict(label="Booth 4", floor_group="Booth Row", shape="rectangle", pos_x=790, pos_y=50, width=160, height=90,
         pos_table_number=4, capacity_min=4, capacity_max=4),
    # Main Dining -- wood 4-tops
    dict(label="Table 1", floor_group="Main Dining", shape="square", pos_x=120, pos_y=240, width=96, height=96,
         pos_table_number=5, capacity_min=4, capacity_max=4),
    dict(label="Table 2", floor_group="Main Dining", shape="square", pos_x=340, pos_y=240, width=96, height=96,
         pos_table_number=6, capacity_min=4, capacity_max=4),
    dict(label="Table 3", floor_group="Main Dining", shape="square", pos_x=560, pos_y=240, width=96, height=96,
         pos_table_number=7, capacity_min=4, capacity_max=4),
    # Main Dining -- small 2-tops
    dict(label="Table 4", floor_group="Main Dining", shape="square", pos_x=120, pos_y=430, width=66, height=66,
         pos_table_number=8, capacity_min=2, capacity_max=2),
    dict(label="Table 5", floor_group="Main Dining", shape="square", pos_x=280, pos_y=430, width=66, height=66,
         pos_table_number=9, capacity_min=2, capacity_max=2),
    dict(label="Table 6", floor_group="Main Dining", shape="square", pos_x=440, pos_y=430, width=66, height=66,
         pos_table_number=10, capacity_min=2, capacity_max=2),
    dict(label="Table 7", floor_group="Main Dining", shape="square", pos_x=600, pos_y=430, width=66, height=66,
         pos_table_number=11, capacity_min=2, capacity_max=2),
    # Main Dining -- round table (capacity a guess)
    dict(label="Round 1", floor_group="Main Dining", shape="round", pos_x=800, pos_y=400, width=110, height=110,
         pos_table_number=12, capacity_min=4, capacity_max=4),
]

# Existing test-seed rows to repurpose (label they currently have -> new label).
RENAME = {
    "VIP Table 1": "Booth 1",
    "Merge-Verify": "Booth 2",
    "QA-POS-Block": "Booth 3",
    "QA-FloorPlan": "Booth 4",
}

existing = {r["label"]: r for r in admin.table("tables").select("*").execute().data}

# A stale QA reservation still holds QA-POS-Block; cancel it so the row can be
# cleanly repurposed as a real booth.
for old_label in ("QA-POS-Block",):
    row = existing.get(old_label)
    if row:
        stuck = (
            admin.table("reservations")
            .select("id, reservation_number")
            .eq("table_id", row["id"])
            .in_("status", ["pending", "confirmed"])
            .execute()
            .data
        )
        for s in stuck:
            admin.table("reservations").update(
                {"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", s["id"]).execute()
            print(f"cancelled stale reservation #{s['reservation_number']} on {old_label}")

# Apply RENAME first so the label lookup below finds the right physical row.
for old_label, new_label in RENAME.items():
    row = existing.get(old_label)
    if row and new_label not in existing:
        admin.table("tables").update({"label": new_label}).eq("id", row["id"]).execute()
        existing[new_label] = {**row, "label": new_label}
        print(f"renamed '{old_label}' -> '{new_label}'")

for spec in LAYOUT:
    row = {
        **spec,
        "capacity": spec["capacity_max"],           # availability engine filters on this
        "active": True,
        "needs_layout_review": True,                 # photo estimate -- confirm on-site
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    match = existing.get(spec["label"])
    if match:
        admin.table("tables").update(row).eq("id", match["id"]).execute()
        print(f"updated  {spec['label']:9} pos#{spec['pos_table_number']:<2} seats {spec['capacity_min']}-{spec['capacity_max']} ({spec['floor_group']})")
    else:
        admin.table("tables").insert(row).execute()
        print(f"inserted {spec['label']:9} pos#{spec['pos_table_number']:<2} seats {spec['capacity_min']}-{spec['capacity_max']} ({spec['floor_group']})")

# Any leftover row not in the layout (e.g. an old test table) -> deactivate,
# don't delete (FK on delete restrict).
layout_labels = {s["label"] for s in LAYOUT}
for label, row in existing.items():
    if label not in layout_labels and row["active"]:
        admin.table("tables").update({"active": False, "pos_table_number": None}).eq("id", row["id"]).execute()
        print(f"deactivated leftover '{label}'")

print("\nFinal active registry:")
for r in admin.table("tables").select("*").eq("active", True).order("pos_table_number").execute().data:
    print(f"  #{r['pos_table_number']:<2} {r['label']:9} {r['floor_group']:12} {r['shape']:9} seats {r['capacity_min']}-{r['capacity_max']} @({r['pos_x']},{r['pos_y']})")
print("\nAll rows flagged needs_layout_review = true -- confirm on-site with the floor-plan editor.")
