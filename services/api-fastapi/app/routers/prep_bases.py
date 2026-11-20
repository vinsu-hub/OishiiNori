"""Prep bases: ingredients the kitchen makes in batches (migration 0086).

Milk tea base, Mousse, Hot Mayo ... are ordinary ingredients that menu
recipes point at -- a sale deducts the base only. What one batch takes lives
in prep_recipe_items; ingredients.prep_yield is how much one batch makes, in
the base's own unit. So:

    base unit_cost = sum(component qty * component unit_cost) / prep_yield

and it is kept in step automatically: saving the batch recipe recomputes it,
and so does changing a component's cost (inventory.py calls
recompute_bases_using). A base can be made from another base (Japanese
rice raw -> Japanese rice cooked -> Japanese sushi rice cooked), so a cost
change carries down the chain; save refuses anything that would loop.

"Made N batches" moves stock: each component goes out (trans_out), the yield
comes into the base (trans_in), through the same apply_inventory_movement
path as every other movement.
"""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import CurrentUser, get_current_user, require_role
from app.cost_log import log_unit_cost
from app.deps import get_supabase
from app.edit_log import log_item_edit
from app.prep_chain import batches_supported, clear_cache as clear_chain_cache
from app.routers.inventory_movements import apply_inventory_movement
from app.stock_alerts import counts_supported_check

router = APIRouter(tags=["prep-bases"])


class PrepComponentIn(BaseModel):
    ingredient_id: str
    qty: float = Field(gt=0)  # in the component's base unit
    unit: str | None = None  # as typed (kg, pack ...), display only


class PrepBaseSave(BaseModel):
    prep_yield: float = Field(gt=0)  # in the base's own unit
    components: list[PrepComponentIn] = Field(min_length=1)


class MakeBatch(BaseModel):
    batches: float = Field(gt=0, le=100)
    note: str | None = None


class ModeSave(BaseModel):
    # 'batch': staff press "Made a batch", a sale takes the base.
    # 'auto': a sale takes what the base is made of, down the chain.
    deduct_mode: Literal["batch", "auto"]


class PrepComponentOut(BaseModel):
    ingredient_id: str
    name: str
    base_unit: str
    qty: float
    unit: str | None = None
    unit_cost: float | None = None
    line_cost: float | None = None


class PrepBaseOut(BaseModel):
    ingredient_id: str
    name: str
    category: str | None = None
    base_unit: str
    prep_yield: float | None = None
    unit_cost: float | None = None
    current_stock: float = 0
    deduct_mode: str = "batch"
    components: list[PrepComponentOut]
    batch_cost: float
    # batch_cost / prep_yield -- null while a component has no cost yet
    cost_per_unit: float | None = None
    missing_cost: list[str]


class MakeBatchOut(BaseModel):
    base: PrepBaseOut
    added: float
    deducted: list[PrepComponentOut]


def _require_0086(supabase) -> None:
    if not counts_supported_check(supabase):
        raise HTTPException(status_code=503, detail="Prep bases need migration 0086 -- run it in the Supabase SQL Editor first")


def _ingredients(supabase, ids) -> dict[str, dict]:
    if not ids:
        return {}
    rows = (
        supabase.table("ingredients")
        .select("id, name, category, base_unit, unit_cost, current_stock, prep_yield")
        .in_("id", list(ids))
        .execute()
        .data
    ) or []
    return {r["id"]: r for r in rows}


def _build(base: dict, lines: list[dict], by_id: dict[str, dict]) -> PrepBaseOut:
    components, missing, batch_cost = [], [], 0.0
    for line in sorted(lines, key=lambda r: (r.get("sort_order") or 0, r.get("created_at") or "")):
        ing = by_id.get(line["ingredient_id"])
        if not ing:
            continue
        qty = float(line["qty"])
        cost = ing.get("unit_cost")
        line_cost = None
        if cost is None:
            missing.append(ing["name"])
        else:
            line_cost = round(qty * float(cost), 4)
            batch_cost += line_cost
        components.append(PrepComponentOut(
            ingredient_id=ing["id"], name=ing["name"], base_unit=ing["base_unit"], qty=qty, unit=line.get("unit"),
            unit_cost=float(cost) if cost is not None else None, line_cost=line_cost,
        ))
    yield_ = float(base["prep_yield"]) if base.get("prep_yield") else None
    per_unit = round(batch_cost / yield_, 4) if yield_ and components and not missing else None
    return PrepBaseOut(
        ingredient_id=base["id"], name=base["name"], category=base.get("category"), base_unit=base["base_unit"],
        prep_yield=yield_, unit_cost=float(base["unit_cost"]) if base.get("unit_cost") is not None else None,
        current_stock=float(base.get("current_stock") or 0), deduct_mode=base.get("deduct_mode") or "batch",
        components=components,
        batch_cost=round(batch_cost, 4), cost_per_unit=per_unit, missing_cost=missing,
    )


def _load(supabase, base_ids: list[str] | None = None) -> list[PrepBaseOut]:
    cols = "id, name, category, base_unit, unit_cost, current_stock, prep_yield"
    if batches_supported(supabase):
        cols += ", deduct_mode"
    query = supabase.table("ingredients").select(cols)
    query = query.in_("id", base_ids) if base_ids is not None else query.not_.is_("prep_yield", "null")
    bases = query.order("name").execute().data or []
    if not bases:
        return []
    lines = (
        supabase.table("prep_recipe_items")
        .select("base_ingredient_id, ingredient_id, qty, unit, sort_order, created_at")
        .in_("base_ingredient_id", [b["id"] for b in bases])
        .execute()
        .data
    ) or []
    by_id = _ingredients(supabase, {line["ingredient_id"] for line in lines})
    by_base: dict[str, list[dict]] = {}
    for line in lines:
        by_base.setdefault(line["base_ingredient_id"], []).append(line)
    return [_build(b, by_base.get(b["id"], []), by_id) for b in bases]


def _apply_cost(supabase, base: PrepBaseOut, changed_by: str | None, note: str) -> PrepBaseOut:
    """Write the batch-derived cost onto the base when it's complete and
    actually different. An incomplete batch (a component has no price yet)
    leaves the base's current cost alone rather than understating it."""
    new = base.cost_per_unit
    if new is None or (base.unit_cost is not None and abs(base.unit_cost - new) < 0.00005):
        return base
    supabase.table("ingredients").update({"unit_cost": new}).eq("id", base.ingredient_id).execute()
    log_unit_cost(
        supabase, base.ingredient_id, new, base.unit_cost, price_paid=round(base.batch_cost, 2), qty=1,
        unit_name="batch", base_qty=base.prep_yield, source="batch", note=note, changed_by=changed_by,
    )
    return base.model_copy(update={"unit_cost": new})


MAX_DEPTH = 5


def _made_from(supabase, ingredient_id: str, target: str) -> bool:
    """True if ingredient_id is target, or is a base whose batch (at any
    depth) takes target."""
    seen, frontier = set(), {ingredient_id}
    for _ in range(MAX_DEPTH + 1):
        if target in frontier:
            return True
        seen |= frontier
        if not frontier:
            return False
        rows = supabase.table("prep_recipe_items").select("ingredient_id").in_("base_ingredient_id", sorted(frontier)).execute().data or []
        frontier = {r["ingredient_id"] for r in rows} - seen
    return bool(frontier)  # deeper than MAX_DEPTH: treat as a loop to be safe


def record_batches(
    supabase, base: PrepBaseOut, n: float, made_by: str, note: str | None = None, source: str = "manual"
) -> tuple[float, list[PrepComponentOut]]:
    """n batches: each component out, the yield in, all tied to one
    prep_batches row (0089) so the item page and suggestions can find them."""
    reason = f"Batch: {base.name} x{n:g}" + (f" -- {note.strip()}" if note and note.strip() else "")
    if source == "eod":
        reason += " (spotted at EOD count)"
    added = round(base.prep_yield * n, 4)
    batch_id = None
    if batches_supported(supabase):
        try:
            batch_id = supabase.table("prep_batches").insert({
                "base_ingredient_id": base.ingredient_id, "batches": n, "yield_qty": added,
                "source": source, "note": (note or "").strip() or None, "made_by": made_by,
            }).execute().data[0]["id"]
        except Exception:  # pragma: no cover - the batch still happens without its log row
            import logging
            logging.getLogger(__name__).exception("could not log batch for %s", base.ingredient_id)
    extra = {"batch_id": batch_id} if batch_id else None
    deducted = []
    for c in base.components:
        apply_inventory_movement(supabase, c.ingredient_id, "trans_out", round(c.qty * n, 4), made_by,
                                 reason=reason, extra=extra)
        deducted.append(c.model_copy(update={"qty": round(c.qty * n, 4)}))
    apply_inventory_movement(supabase, base.ingredient_id, "trans_in", added, made_by, reason=reason, extra=extra)
    return added, deducted


def _recipe_snapshot(supabase, ingredient_id: str, prep_yield) -> dict | None:
    """What one batch takes, for the edit log: {"yield": 2000, "takes": {"Rice": 1000}}."""
    lines = supabase.table("prep_recipe_items").select("ingredient_id, qty").eq("base_ingredient_id", ingredient_id).execute().data or []
    if not lines and not prep_yield:
        return None
    names = _ingredients(supabase, {r["ingredient_id"] for r in lines})
    return {
        "yield": float(prep_yield) if prep_yield else None,
        "takes": {names.get(r["ingredient_id"], {}).get("name", r["ingredient_id"]): float(r["qty"]) for r in lines},
    }


def recompute_bases_using(supabase, ingredient_id: str, changed_by: str | None = None) -> list[PrepBaseOut]:
    """Called after a component's unit_cost changes; a base whose cost moves
    passes the change on to the bases made from it. Best-effort: a failure
    here never fails the cost save that triggered it."""
    try:
        if not counts_supported_check(supabase):
            return []
        out: list[PrepBaseOut] = []
        seen: set[str] = set()
        changed = [ingredient_id]
        for _ in range(MAX_DEPTH):
            rows = supabase.table("prep_recipe_items").select("base_ingredient_id").in_("ingredient_id", changed).execute().data or []
            base_ids = sorted({r["base_ingredient_id"] for r in rows} - seen)
            if not base_ids:
                break
            seen |= set(base_ids)
            changed = []
            for b in _load(supabase, base_ids):
                after = _apply_cost(supabase, b, changed_by, "component cost changed")
                out.append(after)
                if after.unit_cost != b.unit_cost:
                    changed.append(b.ingredient_id)
            if not changed:
                break
        return out
    except Exception:  # pragma: no cover - logged, never raised
        import logging
        logging.getLogger(__name__).exception("could not recompute prep bases using %s", ingredient_id)
        return []


@router.get("/prep-bases", response_model=list[PrepBaseOut])
def list_prep_bases(user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive", "manager", "stocker")
    supabase = get_supabase()
    if not counts_supported_check(supabase):
        return []
    return _load(supabase)


@router.put("/prep-bases/{ingredient_id}", response_model=PrepBaseOut)
def save_prep_base(ingredient_id: str, body: PrepBaseSave, user: CurrentUser = Depends(get_current_user)):
    """Sets (or replaces) what one batch takes and how much it makes, then
    recomputes the base's unit cost. Executive-only, like any cost edit."""
    require_role(user, "executive")
    supabase = get_supabase()
    _require_0086(supabase)

    ids = [c.ingredient_id for c in body.components]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="Each ingredient can only be listed once in a batch")
    if ingredient_id in ids:
        raise HTTPException(status_code=400, detail="A prep base can't be made from itself")
    by_id = _ingredients(supabase, set(ids) | {ingredient_id})
    if ingredient_id not in by_id:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    for cid in ids:
        if cid not in by_id:
            raise HTTPException(status_code=404, detail="A component ingredient was not found")
    # A base may be made from another base, but never (even through others) from itself.
    for cid in ids:
        if _made_from(supabase, cid, ingredient_id):
            raise HTTPException(
                status_code=400,
                detail=f"'{by_id[cid]['name']}' is made from '{by_id[ingredient_id]['name']}', so it can't go into it",
            )

    before = _recipe_snapshot(supabase, ingredient_id, by_id[ingredient_id].get("prep_yield"))
    supabase.table("ingredients").update({"prep_yield": body.prep_yield}).eq("id", ingredient_id).execute()
    supabase.table("prep_recipe_items").delete().eq("base_ingredient_id", ingredient_id).execute()
    supabase.table("prep_recipe_items").insert([
        {"base_ingredient_id": ingredient_id, "ingredient_id": c.ingredient_id, "qty": c.qty,
         "unit": (c.unit or "").strip() or None, "sort_order": i}
        for i, c in enumerate(body.components)
    ]).execute()
    clear_chain_cache()
    log_item_edit(supabase, "batch recipe", before, _recipe_snapshot(supabase, ingredient_id, body.prep_yield),
                  user.id, ingredient_id=ingredient_id)
    (base,) = _load(supabase, [ingredient_id])
    after = _apply_cost(supabase, base, user.id, "batch recipe saved")
    if after.unit_cost != base.unit_cost:
        recompute_bases_using(supabase, ingredient_id, user.id)
    return after


@router.delete("/prep-bases/{ingredient_id}", status_code=204)
def remove_prep_base(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    """Turns a prep base back into a plain (bought) ingredient. Its last
    unit cost stays; recipes that use it are untouched."""
    require_role(user, "executive")
    supabase = get_supabase()
    _require_0086(supabase)
    before = _recipe_snapshot(supabase, ingredient_id, None)
    supabase.table("prep_recipe_items").delete().eq("base_ingredient_id", ingredient_id).execute()
    supabase.table("ingredients").update({"prep_yield": None}).eq("id", ingredient_id).execute()
    clear_chain_cache()
    log_item_edit(supabase, "batch recipe", before, None, user.id, ingredient_id=ingredient_id)


@router.patch("/prep-bases/{ingredient_id}/mode", response_model=PrepBaseOut)
def set_deduct_mode(ingredient_id: str, body: ModeSave, user: CurrentUser = Depends(get_current_user)):
    """Batch (staff press Made a batch) or auto (a sale takes the raw items)."""
    require_role(user, "executive")
    supabase = get_supabase()
    if not batches_supported(supabase):
        raise HTTPException(status_code=503, detail="Needs migration 0089 -- run it in the Supabase SQL Editor first")
    found = _load(supabase, [ingredient_id])
    if not found or not found[0].prep_yield:
        raise HTTPException(status_code=400, detail="Set what one batch takes and how much it makes first")
    old = found[0].deduct_mode
    supabase.table("ingredients").update({"deduct_mode": body.deduct_mode}).eq("id", ingredient_id).execute()
    clear_chain_cache()
    log_item_edit(supabase, "deduct mode", old, body.deduct_mode, user.id, ingredient_id=ingredient_id)
    (refreshed,) = _load(supabase, [ingredient_id])
    return refreshed


@router.post("/prep-bases/{ingredient_id}/make", response_model=MakeBatchOut)
def make_batch(ingredient_id: str, body: MakeBatch, user: CurrentUser = Depends(get_current_user)):
    """"Made N batches": components out, yield in."""
    require_role(user, "executive", "manager", "stocker")
    supabase = get_supabase()
    _require_0086(supabase)
    found = _load(supabase, [ingredient_id])
    if not found or not found[0].prep_yield or not found[0].components:
        raise HTTPException(status_code=400, detail="Set what one batch takes and how much it makes first")
    base = found[0]
    added, deducted = record_batches(supabase, base, body.batches, user.id, note=body.note, source="manual")

    from app.routers.inventory import clear_low_stock_cache
    clear_low_stock_cache()
    (refreshed,) = _load(supabase, [ingredient_id])
    return MakeBatchOut(base=refreshed, added=added, deducted=deducted)
