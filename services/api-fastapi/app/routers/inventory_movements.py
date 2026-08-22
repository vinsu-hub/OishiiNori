from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import InventoryMovementCreate, InventoryMovementResponse, MovementType

router = APIRouter(tags=["inventory-movements"])


@router.post("/inventory-movements", response_model=InventoryMovementResponse)
def create_inventory_movement(body: InventoryMovementCreate, user: CurrentUser = Depends(get_current_user)):
    """Create a manual inventory movement (trans_in, trans_out, delivery,
    transfer_in, transfer_out, count_adjustment) and adjust
    ingredients.current_stock accordingly. Positive-direction types add to
    stock; negative-direction types subtract.
    """
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log movement under another employee's id")

    supabase = get_supabase()

    ingredient_result = (
        supabase.table("ingredients").select("current_stock").eq("id", body.ingredient_id).maybe_single().execute()
    )
    if not ingredient_result or not ingredient_result.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    current_stock = float(ingredient_result.data["current_stock"])

    if body.type in ("trans_out", "transfer_out"):
        new_stock = current_stock - body.quantity
    elif body.type in ("trans_in", "delivery", "transfer_in", "count_adjustment"):
        new_stock = current_stock + body.quantity
    else:
        raise HTTPException(status_code=400, detail=f"Unknown movement type: {body.type}")

    ingredient_update = {"current_stock": new_stock}
    # Most-recent-cost costing: a receiving movement with a supplied cost
    # becomes the ingredient's new unit_cost. No weighted-average, no
    # validation against a "real" cost -- just the latest known price.
    if body.type in ("delivery", "trans_in") and body.unit_cost_snapshot is not None:
        ingredient_update["unit_cost"] = body.unit_cost_snapshot
    supabase.table("ingredients").update(ingredient_update).eq("id", body.ingredient_id).execute()

    insert_result = (
        supabase.table("inventory_movements")
        .insert(
            {
                "ingredient_id": body.ingredient_id,
                "type": body.type,
                "department": body.department,
                "quantity": body.quantity,
                "reason": body.reason,
                "reference_id": body.reference_id,
                "employee_id": body.employee_id,
                "unit_cost_snapshot": body.unit_cost_snapshot,
                "expiry_date": body.expiry_date.isoformat() if body.expiry_date else None,
            }
        )
        .execute()
    )
    return insert_result.data[0]


@router.get("/inventory-movements", response_model=list[InventoryMovementResponse])
def list_inventory_movements(
    ingredient_id: str | None = Query(None),
    type: MovementType | None = Query(None),
    limit: int = Query(100, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("inventory_movements").select("*")
    if ingredient_id:
        query = query.eq("ingredient_id", ingredient_id)
    if type:
        query = query.eq("type", type)
    result = query.order("created_at", desc=True).limit(limit).execute()
    return result.data
