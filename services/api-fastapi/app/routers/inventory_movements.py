from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import InventoryMovementCreate, InventoryMovementResponse, MovementType

router = APIRouter(tags=["inventory-movements"])


def apply_inventory_movement(
    supabase,
    ingredient_id: str | None,
    type: str,
    quantity: float,
    employee_id: str,
    stock_item_id: str | None = None,
    department: str | None = None,
    reason: str | None = None,
    reference_id: str | None = None,
    unit_cost_snapshot: float | None = None,
    expiry_date=None,
) -> InventoryMovementResponse:
    """Adjusts ingredients.current_stock (or, since 0028, stock_items.
    current_stock for an unlinked stock item) for a movement and logs it.
    Positive-direction types add to stock; negative-direction types
    subtract. Exactly one of ingredient_id/stock_item_id must be set.

    Factored out of the /inventory-movements route so the physical
    stock-count tool (stock_items.py) can drive the exact same "New Stocks"
    delivery-logging path and, since 0028, the sale-driven consumption path
    for a stock item (linked or unlinked), instead of a second way of
    adding to current_stock.
    """
    if bool(ingredient_id) == bool(stock_item_id):
        raise HTTPException(status_code=400, detail="Exactly one of ingredient_id or stock_item_id is required")

    table = "ingredients" if ingredient_id else "stock_items"
    target_id = ingredient_id or stock_item_id

    target_result = supabase.table(table).select("id").eq("id", target_id).maybe_single().execute()
    if not target_result or not target_result.data:
        raise HTTPException(status_code=404, detail=f"{'Ingredient' if ingredient_id else 'Stock item'} not found")

    if type in ("trans_out", "transfer_out", "sale_consumption"):
        delta = -quantity
    elif type in ("trans_in", "delivery", "transfer_in", "count_adjustment", "sale_consumption_reversal"):
        delta = quantity
    else:
        raise HTTPException(status_code=400, detail=f"Unknown movement type: {type}")

    # A single atomic `current_stock = current_stock + delta` UPDATE
    # (migration 0046's adjust_ingredient_stock/adjust_stock_item_level RPCs)
    # rather than a select-then-absolute-write -- two concurrent movements
    # against the same row (e.g. a POS sale and a manual count adjustment
    # landing at nearly the same instant) used to race here, with the second
    # write silently discarding the first's delta.
    rpc_name = "adjust_ingredient_stock" if ingredient_id else "adjust_stock_item_level"
    supabase.rpc(rpc_name, {"p_id": target_id, "p_delta": delta}).execute()

    # Most-recent-cost costing: a receiving movement with a supplied cost
    # becomes the ingredient's new unit_cost. No weighted-average, no
    # validation against a "real" cost -- just the latest known price.
    # stock_items has no unit_cost column, so this only ever applies to
    # ingredients (unit_cost_snapshot is simply ignored for a stock item).
    if ingredient_id and type in ("delivery", "trans_in") and unit_cost_snapshot is not None:
        supabase.table("ingredients").update({"unit_cost": unit_cost_snapshot}).eq("id", target_id).execute()

    insert_result = (
        supabase.table("inventory_movements")
        .insert(
            {
                "ingredient_id": ingredient_id,
                "stock_item_id": stock_item_id,
                "type": type,
                "department": department,
                "quantity": quantity,
                "reason": reason,
                "reference_id": reference_id,
                "employee_id": employee_id,
                "unit_cost_snapshot": unit_cost_snapshot,
                "expiry_date": expiry_date.isoformat() if expiry_date else None,
            }
        )
        .execute()
    )
    return insert_result.data[0]


@router.post("/inventory-movements", response_model=InventoryMovementResponse)
def create_inventory_movement(body: InventoryMovementCreate, user: CurrentUser = Depends(get_current_user)):
    """Create a manual inventory movement (trans_in, trans_out, delivery,
    transfer_in, transfer_out, count_adjustment) and adjust the target's
    current_stock accordingly. Positive-direction types add to stock;
    negative-direction types subtract.
    """
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log movement under another employee's id")

    supabase = get_supabase()
    return apply_inventory_movement(
        supabase,
        body.ingredient_id,
        body.type,
        body.quantity,
        body.employee_id,
        stock_item_id=body.stock_item_id,
        department=body.department,
        reason=body.reason,
        reference_id=body.reference_id,
        unit_cost_snapshot=body.unit_cost_snapshot,
        expiry_date=body.expiry_date,
    )


@router.get("/inventory-movements", response_model=list[InventoryMovementResponse])
def list_inventory_movements(
    ingredient_id: str | None = Query(None),
    stock_item_id: str | None = Query(None),
    type: MovementType | None = Query(None),
    limit: int = Query(100, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("inventory_movements").select("*")
    if ingredient_id:
        query = query.eq("ingredient_id", ingredient_id)
    if stock_item_id:
        query = query.eq("stock_item_id", stock_item_id)
    if type:
        query = query.eq("type", type)
    result = query.order("created_at", desc=True).limit(limit).execute()
    return result.data
