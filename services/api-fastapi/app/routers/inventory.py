from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.schemas import (
    ExpiringIngredient,
    IngredientOut,
    IngredientUpdate,
    InventoryCountRequest,
    InventoryCountResponse,
)

router = APIRouter(tags=["inventory"])


@router.get("/inventory", response_model=list[IngredientOut])
def list_inventory(user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("ingredients").select("*").order("name").execute()
    return result.data


@router.get("/inventory/expiring-soon", response_model=list[ExpiringIngredient])
def list_expiring_soon(days: int = Query(7, ge=1, le=90), user: CurrentUser = Depends(get_current_user)):
    """Advisory, not exact FIFO tracking: for each ingredient, look at its
    single most recent delivery/trans_in movement that has an expiry_date,
    and flag it if that date falls within the next `days` days. This
    schema has no per-batch remaining-quantity tracking, only a running
    current_stock total, so this can't know whether that specific batch
    has already been fully consumed -- it's a heads-up, not a guarantee.
    """
    supabase = get_supabase()
    horizon = date.today() + timedelta(days=days)

    movements_result = (
        supabase.table("inventory_movements")
        .select("ingredient_id, expiry_date, created_at")
        .in_("type", ["delivery", "trans_in"])
        .not_.is_("expiry_date", "null")
        .order("created_at", desc=True)
        .execute()
    )

    latest_expiry_by_ingredient: dict[str, str] = {}
    for m in movements_result.data:
        # First row seen per ingredient is the most recent (already
        # ordered desc), so only take it the first time.
        latest_expiry_by_ingredient.setdefault(m["ingredient_id"], m["expiry_date"])

    upcoming = {
        ing_id: expiry
        for ing_id, expiry in latest_expiry_by_ingredient.items()
        if date.fromisoformat(expiry) <= horizon
    }
    if not upcoming:
        return []

    ingredients_result = (
        supabase.table("ingredients").select("id, name, base_unit").in_("id", list(upcoming.keys())).execute()
    )
    today = date.today()
    rows = [
        ExpiringIngredient(
            ingredient_id=i["id"],
            ingredient_name=i["name"],
            base_unit=i["base_unit"],
            expiry_date=upcoming[i["id"]],
            days_until_expiry=(date.fromisoformat(upcoming[i["id"]]) - today).days,
        )
        for i in ingredients_result.data
    ]
    rows.sort(key=lambda r: r.days_until_expiry)
    return rows


@router.get("/inventory/{ingredient_id}", response_model=IngredientOut)
def get_ingredient(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("ingredients").select("*").eq("id", ingredient_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return result.data


@router.patch("/inventory/{ingredient_id}", response_model=IngredientOut)
def update_ingredient(
    ingredient_id: str,
    body: IngredientUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    """Direct edit of an ingredient's financial baseline (unit_cost) --
    executive-only, since this feeds the P&L dashboard's COGS calculation.
    Distinct from the indirect unit_cost_snapshot path on delivery/trans_in
    movements (inventory_movements.py) -- both are plain column writes, so
    whichever happens last wins, same as two delivery movements already
    behave under this schema's most-recent-cost costing."""
    require_role(user, "executive")
    supabase = get_supabase()
    existing = supabase.table("ingredients").select("id").eq("id", ingredient_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = supabase.table("ingredients").update(update_data).eq("id", ingredient_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return result.data[0]


@router.post("/inventory/{ingredient_id}/count", response_model=InventoryCountResponse)
def count_inventory(
    ingredient_id: str,
    body: InventoryCountRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Records a physical stock count. Unlike a manual movement, a count
    sets current_stock directly to what was actually counted rather than
    applying a delta -- and, when the counted value differs from what the
    system expected, logs a count_adjustment movement (previous/counted/
    signed variance) so the discrepancy has a real audit trail instead of
    silently vanishing into an overwrite. A zero-variance count logs nothing.
    """
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a count under another employee's id")

    supabase = get_supabase()
    existing = (
        supabase.table("ingredients").select("current_stock").eq("id", ingredient_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    previous_stock = float(existing.data["current_stock"])
    variance = round(body.counted_stock - previous_stock, 4)

    result = (
        supabase.table("ingredients").update({"current_stock": body.counted_stock}).eq("id", ingredient_id).execute()
    )
    updated_ingredient = result.data[0]

    movement = None
    if variance != 0:
        movement_result = (
            supabase.table("inventory_movements")
            .insert(
                {
                    "ingredient_id": ingredient_id,
                    "type": "count_adjustment",
                    "quantity": abs(variance),
                    "reason": f"Stock count: {previous_stock} -> {body.counted_stock} (variance {variance:+})",
                    "employee_id": body.employee_id,
                }
            )
            .execute()
        )
        movement = movement_result.data[0]

    return InventoryCountResponse(ingredient=updated_ingredient, movement=movement, variance=variance)
