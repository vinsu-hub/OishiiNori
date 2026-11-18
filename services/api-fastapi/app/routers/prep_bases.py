"""Prep bases: ingredients the kitchen makes in batches (migration 0086).

Milk tea base, Mousse, Hot Mayo ... are ordinary ingredients that menu
recipes point at -- a sale deducts the base only. What one batch takes lives
in prep_recipe_items; ingredients.prep_yield is how much one batch makes, in
the base's own unit. So:

    base unit_cost = sum(component qty * component unit_cost) / prep_yield

and it is kept in step automatically: saving the batch recipe recomputes it,
and so does changing a component's cost (inventory.py calls
recompute_bases_using). Only one level -- a base can't be a component of
another base -- so a cost change never cascades.

"Made N batches" moves stock: each component goes out (trans_out), the yield
comes into the base (trans_in), through the same apply_inventory_movement
path as every other movement.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import CurrentUser, get_current_user, require_role
from app.cost_log import log_unit_cost
from app.deps import get_supabase
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
        current_stock=float(base.get("current_stock") or 0), components=components,
        batch_cost=round(batch_cost, 4), cost_per_unit=per_unit, missing_cost=missing,
    )


def _load(supabase, base_ids: list[str] | None = None) -> list[PrepBaseOut]:
    query = supabase.table("ingredients").select("id, name, category, base_unit, unit_cost, current_stock, prep_yield")
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


def recompute_bases_using(supabase, ingredient_id: str, changed_by: str | None = None) -> list[PrepBaseOut]:
    """Called after a component's unit_cost changes. Best-effort: a failure
    here never fails the cost save that triggered it."""
    try:
        if not counts_supported_check(supabase):
            return []
        rows = supabase.table("prep_recipe_items").select("base_ingredient_id").eq("ingredient_id", ingredient_id).execute().data or []
        base_ids = sorted({r["base_ingredient_id"] for r in rows})
        if not base_ids:
            return []
        return [_apply_cost(supabase, b, changed_by, "component cost changed") for b in _load(supabase, base_ids)]
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
        if by_id[cid].get("prep_yield"):
            raise HTTPException(status_code=400, detail=f"'{by_id[cid]['name']}' is itself a prep base -- bases can't go inside other bases")
    used_as_component = supabase.table("prep_recipe_items").select("id").eq("ingredient_id", ingredient_id).limit(1).execute().data
    if used_as_component:
        raise HTTPException(status_code=400, detail=f"'{by_id[ingredient_id]['name']}' is used inside another prep base, so it can't be one itself")

    supabase.table("ingredients").update({"prep_yield": body.prep_yield}).eq("id", ingredient_id).execute()
    supabase.table("prep_recipe_items").delete().eq("base_ingredient_id", ingredient_id).execute()
    supabase.table("prep_recipe_items").insert([
        {"base_ingredient_id": ingredient_id, "ingredient_id": c.ingredient_id, "qty": c.qty,
         "unit": (c.unit or "").strip() or None, "sort_order": i}
        for i, c in enumerate(body.components)
    ]).execute()
    (base,) = _load(supabase, [ingredient_id])
    return _apply_cost(supabase, base, user.id, "batch recipe saved")


@router.delete("/prep-bases/{ingredient_id}", status_code=204)
def remove_prep_base(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    """Turns a prep base back into a plain (bought) ingredient. Its last
    unit cost stays; recipes that use it are untouched."""
    require_role(user, "executive")
    supabase = get_supabase()
    _require_0086(supabase)
    supabase.table("prep_recipe_items").delete().eq("base_ingredient_id", ingredient_id).execute()
    supabase.table("ingredients").update({"prep_yield": None}).eq("id", ingredient_id).execute()


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
    n = body.batches
    reason = f"Batch: {base.name} x{n:g}" + (f" -- {body.note.strip()}" if body.note and body.note.strip() else "")
    deducted = []
    for c in base.components:
        apply_inventory_movement(supabase, c.ingredient_id, "trans_out", round(c.qty * n, 4), user.id, reason=reason)
        deducted.append(c.model_copy(update={"qty": round(c.qty * n, 4)}))
    added = round(base.prep_yield * n, 4)
    apply_inventory_movement(supabase, ingredient_id, "trans_in", added, user.id, reason=reason)

    from app.routers.inventory import clear_low_stock_cache
    clear_low_stock_cache()
    (refreshed,) = _load(supabase, [ingredient_id])
    return MakeBatchOut(base=refreshed, added=added, deducted=deducted)
