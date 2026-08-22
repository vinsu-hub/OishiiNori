"""One-time backfill: for every ingredient with unit_cost still null, find
its most recent delivery/trans_in movement that has a unit_cost_snapshot
and copy it forward. Disposable script, not pytest/CI -- run manually.

Direct service-role DB access (no admin endpoint exists for this), same
pattern as this project's other scripts/*.py one-off scripts.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

supabase = get_supabase()

ingredients = (
    supabase.table("ingredients")
    .select("id, name, unit_cost")
    .is_("unit_cost", "null")
    .execute()
    .data
)
print(f"{len(ingredients)} ingredient(s) with no unit_cost yet.")

updated = 0
for ing in ingredients:
    movement = (
        supabase.table("inventory_movements")
        .select("unit_cost_snapshot, created_at")
        .eq("ingredient_id", ing["id"])
        .in_("type", ["delivery", "trans_in"])
        .not_.is_("unit_cost_snapshot", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
        .data
    )
    if not movement:
        continue
    cost = movement[0]["unit_cost_snapshot"]
    supabase.table("ingredients").update({"unit_cost": cost}).eq("id", ing["id"]).execute()
    print(f"  {ing['name']}: unit_cost -> {cost}")
    updated += 1

print(f"Done. {updated} ingredient(s) backfilled, {len(ingredients) - updated} had no priced delivery history.")
