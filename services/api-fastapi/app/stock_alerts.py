"""The one low-stock rule every screen uses (Sidebar badge, Home, Stock
Alerts, Command Center, the AI assistant, POS availability).

An ingredient is LOW when
  * it has been physically counted since the last stock reset
    (ingredients.last_counted_at, migration 0086) -- a stock that was just
    reset to 0 and not counted yet is "not counted", not "low";
  * it has a real threshold (reorder_threshold > 0) -- the default 0 means
    "no threshold set", otherwise every empty row alerts at 0 <= 0;
  * and current_stock <= reorder_threshold.

Before 0086 is run there is no last_counted_at, and every ingredient counts
as counted (the old behaviour, minus the 0-threshold noise).
"""
import time

_supported: bool | None = None
_checked_at = 0.0
_active_supported: bool | None = None
_active_checked_at = 0.0


def counts_supported_check(supabase) -> bool:
    """Is migration 0086 (last_counted_at, prep bases) in? Re-checked every
    minute while it isn't, so a running server picks it up."""
    global _supported, _checked_at
    if _supported or time.monotonic() - _checked_at < 60:
        return bool(_supported)
    _checked_at = time.monotonic()
    try:
        supabase.table("ingredients").select("last_counted_at, prep_yield").limit(1).execute()
        supabase.table("prep_recipe_items").select("id").limit(1).execute()
        _supported = True
    except Exception:
        _supported = False
    return _supported


def active_supported_check(supabase) -> bool:
    """Is migration 0087 (ingredients.active) in? Same re-check rule."""
    global _active_supported, _active_checked_at
    if _active_supported or time.monotonic() - _active_checked_at < 60:
        return bool(_active_supported)
    _active_checked_at = time.monotonic()
    try:
        supabase.table("ingredients").select("active").limit(1).execute()
        _active_supported = True
    except Exception:
        _active_supported = False
    return _active_supported


def with_counted(supabase, columns: str) -> str:
    """`columns` plus last_counted_at (0086) and active (0087) when they exist."""
    if counts_supported_check(supabase):
        columns += ", last_counted_at"
    if active_supported_check(supabase):
        columns += ", active"
    return columns


def is_active(row: dict) -> bool:
    """Removed from inventory (0087) = active false. Missing column = active."""
    return row.get("active", True) is not False


def is_counted(row: dict) -> bool:
    if "last_counted_at" not in row:  # pre-0086 select
        return True
    return row.get("last_counted_at") is not None


def is_low(row: dict) -> bool:
    threshold = float(row.get("reorder_threshold") or 0)
    return is_active(row) and is_counted(row) and threshold > 0 and float(row.get("current_stock") or 0) <= threshold


def is_low_stock_item(row: dict) -> bool:
    """Station items (packaging, resale): no count tracking, so only the
    threshold rule. Null or 0 threshold = no alert."""
    threshold = row.get("reorder_threshold")
    return threshold is not None and float(threshold) > 0 and float(row.get("current_stock") or 0) <= float(threshold)
