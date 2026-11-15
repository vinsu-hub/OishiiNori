"""Ingredient price history (migration 0085).

ingredients.unit_cost is the single number recipes, food cost and P&L use.
Every time it is set -- typed on Recipes & Costs, carried in by a delivery,
or loaded by an import script -- a row here records what was actually paid
("P1050 for 1 box of 2000 g"), the cost before, who did it and when.

Logging is best-effort: a missing table (0085 not run yet) or a failed
insert never blocks saving the cost itself.
"""
import logging
import time

log = logging.getLogger(__name__)

_supported: bool | None = None
_checked_at = 0.0


def cost_log_supported_check(supabase) -> bool:
    """Once the table is there it stays there; "missing" is re-checked every
    minute so a server that started before 0085 picks it up."""
    global _supported, _checked_at
    if _supported or time.monotonic() - _checked_at < 60:
        return bool(_supported)
    _checked_at = time.monotonic()
    try:
        supabase.table("ingredient_cost_log").select("id").limit(1).execute()
        _supported = True
    except Exception:
        _supported = False
    return _supported


def _num(value):
    return float(value) if value is not None else None


def log_unit_cost(
    supabase,
    ingredient_id: str,
    unit_cost: float,
    previous_unit_cost: float | None = None,
    *,
    price_paid: float | None = None,
    qty: float | None = None,
    unit_name: str | None = None,
    base_qty: float | None = None,
    source: str = "manual",
    note: str | None = None,
    changed_by: str | None = None,
) -> None:
    if not cost_log_supported_check(supabase):
        return
    try:
        supabase.table("ingredient_cost_log").insert({
            "ingredient_id": ingredient_id,
            "unit_cost": round(float(unit_cost), 4),
            "previous_unit_cost": _num(previous_unit_cost),
            "price_paid": _num(price_paid),
            "qty": _num(qty),
            "unit_name": (unit_name or "").strip() or None,
            "base_qty": _num(base_qty),
            "source": source,
            "note": (note or "").strip() or None,
            "changed_by": changed_by,
        }).execute()
    except Exception:  # never block the cost save on the history row
        log.exception("could not log unit cost for ingredient %s", ingredient_id)


def latest_purchases(supabase, ingredient_ids: list[str] | None = None) -> dict[str, dict]:
    """ingredient_id -> its newest log row (with the staff name), in one
    request. Empty when 0085 hasn't run."""
    if not cost_log_supported_check(supabase):
        return {}
    try:
        query = (
            supabase.table("ingredient_cost_log")
            .select("ingredient_id, unit_cost, previous_unit_cost, price_paid, qty, unit_name, base_qty, source, note, created_at, profiles(full_name)")
            .order("created_at", desc=True)
            .limit(2000)
        )
        if ingredient_ids is not None:
            query = query.in_("ingredient_id", ingredient_ids)
        rows = query.execute().data or []
    except Exception:
        log.exception("could not read ingredient cost log")
        return {}
    latest: dict[str, dict] = {}
    for row in rows:
        latest.setdefault(row["ingredient_id"], to_history_entry(row))
    return latest


def to_history_entry(row: dict) -> dict:
    profile = row.get("profiles") or {}
    return {
        "unit_cost": float(row["unit_cost"]),
        "previous_unit_cost": _num(row.get("previous_unit_cost")),
        "price_paid": _num(row.get("price_paid")),
        "qty": _num(row.get("qty")),
        "unit_name": row.get("unit_name"),
        "base_qty": _num(row.get("base_qty")),
        "source": row.get("source") or "manual",
        "note": row.get("note"),
        "changed_by_name": profile.get("full_name") if isinstance(profile, dict) else None,
        "created_at": row["created_at"],
    }
