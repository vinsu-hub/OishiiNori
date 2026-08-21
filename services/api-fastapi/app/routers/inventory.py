from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import IngredientOut, InventoryCountRequest, InventoryCountResponse

router = APIRouter(tags=["inventory"])


@router.get("/inventory", response_model=list[IngredientOut])
def list_inventory(user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("ingredients").select("*").order("name").execute()
    return result.data


@router.get("/inventory/{ingredient_id}", response_model=IngredientOut)
def get_ingredient(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("ingredients").select("*").eq("id", ingredient_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return result.data


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
