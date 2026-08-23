"""Physical stock count tool: digitizes the client's 4 handwritten daily
station stock sheets (New Stocks / Beginning / Usage / Ending format).

Deliberately reuses the existing ingredient-stock machinery for stock items
that ARE recipe ingredients (apply_ingredient_count / apply_inventory_movement,
factored out of inventory.py / inventory_movements.py) rather than a second,
competing way to mutate ingredients.current_stock. Items with no ingredient
link (packaging, supplies, resale beverages -- most of the sheet) get simple
direct tracking on stock_items.current_stock instead, since no recipe/COGS
system exists for them to plug into.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.routers.inventory import apply_ingredient_count
from app.routers.inventory_movements import apply_inventory_movement
from app.schemas import (
    StockCountEntryCreate,
    StockCountEntryOut,
    StockCountEntryResponse,
    StockItemCreate,
    StockItemOut,
    StockItemUpdate,
    StockStation,
)

router = APIRouter(tags=["stock-items"])


def _to_stock_item_out(row: dict) -> dict:
    ingredient = row.pop("ingredients", None) or {}
    row["ingredient_name"] = ingredient.get("name")
    row["ingredient_current_stock"] = ingredient.get("current_stock")
    return row


@router.get("/stock-items", response_model=list[StockItemOut])
def list_stock_items(
    station: StockStation | None = Query(None),
    active_only: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("stock_items").select("*, ingredients(name, current_stock)")
    if station:
        query = query.eq("station", station)
    if active_only:
        query = query.eq("active", True)
    result = query.order("name").execute()
    return [_to_stock_item_out(row) for row in result.data]


@router.get("/stock-items/count-entries", response_model=list[StockCountEntryOut])
def list_count_entries(
    station: StockStation = Query(...),
    count_date: date | None = Query(None, alias="date"),
    user: CurrentUser = Depends(get_current_user),
):
    """Hydrates a station's grid for a given day (defaults today)."""
    if count_date is None:
        count_date = date.today()
    supabase = get_supabase()
    items = supabase.table("stock_items").select("id").eq("station", station).execute().data
    item_ids = [i["id"] for i in items]
    if not item_ids:
        return []
    result = (
        supabase.table("stock_count_entries")
        .select("*")
        .in_("stock_item_id", item_ids)
        .eq("count_date", count_date.isoformat())
        .execute()
    )
    return result.data


@router.post("/stock-items", response_model=StockItemOut)
def create_stock_item(body: StockItemCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    result = (
        supabase.table("stock_items")
        .insert(
            {
                "name": body.name,
                "station": body.station,
                "category": body.category,
                "unit": body.unit,
                "ingredient_id": body.ingredient_id,
                "reorder_threshold": body.reorder_threshold,
            }
        )
        .select("*, ingredients(name, current_stock)")
        .execute()
    )
    return _to_stock_item_out(result.data[0])


@router.patch("/stock-items/{stock_item_id}", response_model=StockItemOut)
def update_stock_item(stock_item_id: str, body: StockItemUpdate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    existing = supabase.table("stock_items").select("id").eq("id", stock_item_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Stock item not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = (
        supabase.table("stock_items")
        .update(update_data)
        .eq("id", stock_item_id)
        .select("*, ingredients(name, current_stock)")
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Stock item not found")
    return _to_stock_item_out(result.data[0])


@router.post("/stock-items/{stock_item_id}/count-entries", response_model=StockCountEntryResponse)
def record_count_entry(
    stock_item_id: str,
    body: StockCountEntryCreate,
    user: CurrentUser = Depends(get_current_user),
):
    """Upserts today's (or a given date's) count entry for one stock item,
    then -- for a stock item linked to a recipe ingredient -- drives the
    exact same current_stock-mutation paths the existing Inventory Count
    (apply_ingredient_count) and Receive Shipment (apply_inventory_movement)
    pages already use, so there is exactly one place that ever mutates a
    linked ingredient's current_stock regardless of which page it came from.
    """
    if body.recorded_by != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a count under another employee's id")

    supabase = get_supabase()
    item_result = supabase.table("stock_items").select("*").eq("id", stock_item_id).maybe_single().execute()
    if not item_result or not item_result.data:
        raise HTTPException(status_code=404, detail="Stock item not found")
    stock_item = item_result.data

    count_date = body.count_date or date.today()

    existing_entry = (
        supabase.table("stock_count_entries")
        .select("*")
        .eq("stock_item_id", stock_item_id)
        .eq("count_date", count_date.isoformat())
        .maybe_single()
        .execute()
    )

    entry_data = body.model_dump(exclude_unset=True, exclude={"recorded_by", "count_date"})
    entry_data["updated_at"] = datetime.now(timezone.utc).isoformat()

    if existing_entry and existing_entry.data:
        entry_result = (
            supabase.table("stock_count_entries")
            .update(entry_data)
            .eq("id", existing_entry.data["id"])
            .execute()
        )
    else:
        entry_data.update(
            {
                "stock_item_id": stock_item_id,
                "count_date": count_date.isoformat(),
                "recorded_by": body.recorded_by,
            }
        )
        entry_result = supabase.table("stock_count_entries").insert(entry_data).execute()
    entry = entry_result.data[0]

    ingredient_count_result = None
    delivery_movement = None

    if stock_item["ingredient_id"]:
        if body.ending is not None:
            ingredient_count_result = apply_ingredient_count(
                supabase, stock_item["ingredient_id"], body.ending, body.recorded_by
            )
        if body.new_stocks is not None and body.new_stocks > 0:
            # No reference_id -- that column is FK'd to transfers(id)
            # (migration 0015), so it can't point at a stock_count_entries
            # row; omitted, exactly like a regular delivery movement.
            delivery_movement = apply_inventory_movement(
                supabase,
                stock_item["ingredient_id"],
                "delivery",
                body.new_stocks,
                body.recorded_by,
                reason=f"Physical stock count -- {stock_item['station']} station",
            )
    else:
        item_update = {}
        if body.ending is not None:
            item_update["current_stock"] = body.ending
        elif body.new_stocks is not None and body.new_stocks > 0:
            item_update["current_stock"] = float(stock_item["current_stock"]) + body.new_stocks
        if item_update:
            item_update["updated_at"] = datetime.now(timezone.utc).isoformat()
            supabase.table("stock_items").update(item_update).eq("id", stock_item_id).execute()

    refreshed = (
        supabase.table("stock_items")
        .select("*, ingredients(name, current_stock)")
        .eq("id", stock_item_id)
        .maybe_single()
        .execute()
    )
    stock_item_out = _to_stock_item_out(refreshed.data)

    return StockCountEntryResponse(
        entry=entry,
        stock_item=stock_item_out,
        ingredient_count_result=ingredient_count_result,
        delivery_movement=delivery_movement,
    )
