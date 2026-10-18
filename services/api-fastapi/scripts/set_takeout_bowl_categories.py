"""Which menu categories carry the ₱10 take-out bowl on pickup/delivery orders.

Owner's instruction (2026-10-19): only ramen, rice meals and donburi (Gohan and
Kare Raisu / Curry count as rice meals); everything else has no bowl charge.

    .venv/bin/python scripts/set_takeout_bowl_categories.py [--apply]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

BOWL_CATEGORIES = {"Ramen", "Ramen (Premium)", "Ramen (Regular)", "Rice Meals", "Donburi", "Gohan", "Kare Raisu / Curry"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from app.deps import get_supabase
    db = get_supabase()
    rows = db.table("products").select("id,name,category,takeout_bowl_eligible").execute().data
    changes = [(r, r["category"] in BOWL_CATEGORIES) for r in rows if (r["category"] in BOWL_CATEGORIES) != r["takeout_bowl_eligible"]]
    for r, want in sorted(changes, key=lambda c: (c[0]["category"], c[0]["name"])):
        print(f"  {'+ bowl' if want else '- bowl'}  {r['category']:32} {r['name']}")
        if args.apply:
            db.table("products").update({"takeout_bowl_eligible": want}).eq("id", r["id"]).execute()
    print(f"{len(changes)} change(s)." + ("" if args.apply else " Dry run; --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
