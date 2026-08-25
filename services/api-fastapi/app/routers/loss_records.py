from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import CreateLossRecordRequest, LossRecordResponse

router = APIRouter(tags=["loss-records"])


@router.post("/loss-records", response_model=LossRecordResponse)
def create_loss_record(body: CreateLossRecordRequest, user: CurrentUser = Depends(get_current_user)):
    """Logs a loss/defect event and deducts the lost quantity from
    inventory, separately from sale-driven consumption so losses show up
    distinctly rather than silently looking like a sale.

    Exactly one of ingredient_id/stock_item_id is required (0028) -- a loss
    on an unlinked stock item (e.g. a broken bottle of Sprite) deducts
    stock_items.current_stock the same way an ingredient loss deducts
    ingredients.current_stock; a loss on a LINKED stock item should be
    logged against its real ingredient_id instead (same routing rule
    stock_items.py's record_count_entry already enforces for Ending/New
    Stocks), not a new stock_item_id row.
    """
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a loss under another employee's id")
    if bool(body.ingredient_id) == bool(body.stock_item_id):
        raise HTTPException(status_code=400, detail="Exactly one of ingredient_id or stock_item_id is required")

    supabase = get_supabase()
    table = "ingredients" if body.ingredient_id else "stock_items"
    target_id = body.ingredient_id or body.stock_item_id

    target_result = (
        supabase.table(table)
        .select("current_stock" + (", unit_cost" if body.ingredient_id else ""))
        .eq("id", target_id)
        .maybe_single()
        .execute()
    )
    if not target_result or not target_result.data:
        raise HTTPException(status_code=404, detail=f"{'Ingredient' if body.ingredient_id else 'Stock item'} not found")

    if body.product_id:
        product_result = (
            supabase.table("products").select("id").eq("id", body.product_id).maybe_single().execute()
        )
        if not product_result or not product_result.data:
            raise HTTPException(status_code=404, detail="Product not found")

    # Falls back to the ingredient's most-recent-cost (see
    # inventory_movements.py) when the caller supplies neither -- this is
    # what the Inventory Count shrinkage-dialog flow hits, since it never
    # asks for a cost, so shrinkage/spoilage gets a real cost_impact
    # instead of silently recording ₱0 whenever a cost is known. stock_items
    # has no unit_cost column, so an unlinked stock-item loss only ever gets
    # a cost_impact from an explicit caller-supplied value, defaulting to 0
    # -- a known, accepted gap (packaging/supply cost tracking was never in
    # scope).
    if body.cost_impact is not None:
        cost_impact = round(body.cost_impact, 2)
    elif body.unit_cost is not None:
        cost_impact = round(body.unit_cost * body.quantity, 2)
    elif body.ingredient_id and target_result.data.get("unit_cost") is not None:
        cost_impact = round(float(target_result.data["unit_cost"]) * body.quantity, 2)
    else:
        cost_impact = 0.0

    # A count-driven shrinkage loss (skip_stock_deduction=True) is logged
    # after Count Stock has already set current_stock to the true physical
    # count -- deducting again here would double-count the shortage.
    if not body.skip_stock_deduction:
        new_stock = float(target_result.data["current_stock"]) - body.quantity
        supabase.table(table).update({"current_stock": new_stock}).eq("id", target_id).execute()

    insert_result = (
        supabase.table("loss_records")
        .insert(
            {
                "ingredient_id": body.ingredient_id,
                "stock_item_id": body.stock_item_id,
                "product_id": body.product_id,
                "employee_id": body.employee_id,
                "reason": body.reason,
                "quantity": body.quantity,
                "cost_impact": cost_impact,
                "photo_url": body.photo_url,
                "skip_stock_deduction": body.skip_stock_deduction,
            }
        )
        .execute()
    )
    return insert_result.data[0]


@router.get("/loss-records", response_model=list[LossRecordResponse])
def list_loss_records(limit: int = Query(50, le=200), user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("loss_records").select("*").order("created_at", desc=True).limit(limit).execute()
    return result.data
