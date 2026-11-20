"""Opening up 'auto' prep bases on a sale (migration 0089).

A prep base is either made in batches ('batch': staff press "Made a batch",
a sale takes the base) or taken straight from what it's made of ('auto': a
sale of 10 g Kikoman mix takes 8 g Kikoman + 2 ml water). Auto bases can sit
inside other bases, so this follows the chain down, up to MAX_DEPTH levels.

Same rule as the SQL function recipe_lines_expanded (used by bundles), so a
roll sold on its own and a roll in a bundle take the same stock.

The auto bases are cached for a few minutes: a sale costs no extra query
most of the time (Vercel bills CPU and every request counts). Saving a
batch recipe or switching a mode clears this instance's copy.
"""
import time

from postgrest.exceptions import APIError

MAX_DEPTH = 5
_TTL_SECONDS = 300
_cache: dict = {"at": 0.0, "bases": None}


def clear_cache() -> None:
    _cache["at"], _cache["bases"] = 0.0, None


def auto_bases(supabase) -> dict[str, tuple[float, list[tuple[str, float]]]]:
    """id -> (yield, [(component id, qty per batch)]) for every auto base."""
    now = time.monotonic()
    if _cache["bases"] is not None and now - _cache["at"] < _TTL_SECONDS:
        return _cache["bases"]
    bases: dict[str, tuple[float, list[tuple[str, float]]]] = {}
    try:
        rows = (supabase.table("ingredients").select("id, prep_yield")
                .eq("deduct_mode", "auto").execute().data) or []
        rows = [r for r in rows if r.get("prep_yield")]
        if rows:
            ids = [r["id"] for r in rows]
            comps = (supabase.table("prep_recipe_items").select("base_ingredient_id, ingredient_id, qty")
                     .in_("base_ingredient_id", ids).execute().data) or []
            by_base: dict[str, list[tuple[str, float]]] = {}
            for c in comps:
                by_base.setdefault(c["base_ingredient_id"], []).append((c["ingredient_id"], float(c["qty"])))
            bases = {r["id"]: (float(r["prep_yield"]), by_base[r["id"]]) for r in rows if by_base.get(r["id"])}
    except APIError:
        bases = {}  # before 0089: no deduct_mode column, nothing is auto
    _cache["at"], _cache["bases"] = now, bases
    return bases


def expand(supabase, lines: list[tuple[str, float]]) -> dict[str, float]:
    """[(ingredient id, qty)] -> {ingredient id: qty} with auto bases opened
    up into their components, merged per ingredient (order kept)."""
    bases = auto_bases(supabase)
    out: dict[str, float] = {}
    stack = [(iid, qty, 0) for iid, qty in reversed(lines)]
    while stack:
        iid, qty, depth = stack.pop()
        base = bases.get(iid)
        if base and depth < MAX_DEPTH:
            yield_, comps = base
            for cid, cqty in reversed(comps):
                stack.append((cid, qty * cqty / yield_, depth + 1))
            continue
        out[iid] = out.get(iid, 0.0) + qty
    return {k: round(v, 4) for k, v in out.items()}


_support: dict = {"at": 0.0, "ok": None}


def batches_supported(supabase) -> bool:
    """Is migration 0089 in (deduct_mode, prep_batches, item_edit_log ...)?
    Checked once every few minutes."""
    now = time.monotonic()
    if _support["ok"] is not None and now - _support["at"] < _TTL_SECONDS:
        return _support["ok"]
    try:
        supabase.table("ingredients").select("deduct_mode").limit(1).execute()
        ok = True
    except APIError:
        ok = False
    _support["at"], _support["ok"] = now, ok
    return ok
