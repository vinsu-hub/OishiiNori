"""Physical stock count tool: digitizes the client's 4 handwritten daily
station stock sheets (New Stocks / Beginning / Usage / Ending format).

For a stock item that IS a recipe ingredient, this router deliberately does
NOT edit ingredients.current_stock at all -- that would be a second,
competing way to mutate the same number Inventory Count (Ending, via
apply_ingredient_count in inventory.py) and Receive Shipment (New Stocks,
via apply_inventory_movement in inventory_movements.py) already own.
record_count_entry rejects new_stocks/ending for a linked item outright;
Beginning/Usage/Notes/needs_verification stay recordable as informational
context regardless. Items with no ingredient link (packaging, supplies,
resale beverages -- most of the sheet) get simple direct tracking on
stock_items.current_stock instead, since no recipe/COGS system exists for
them to plug into.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.schemas import (
    LowStockStockItem,
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


def get_low_stock_stock_items(supabase) -> list[LowStockStockItem]:
    """Unlinked stock items (packaging/supplies/resale) at or below their
    own reorder_threshold -- a column that existed since migration 0022 but
    was never read by any route until now. Deliberately excludes linked
    items: a linked item's real stock lives on ingredients.current_stock
    (get_low_stock_ingredients in inventory.py already covers it), so
    including it here would double-count the same shortage twice."""
    result = (
        supabase.table("stock_items")
        .select("id, name, station, current_stock, reorder_threshold, unit")
        .eq("active", True)
        .is_("ingredient_id", "null")
        .not_.is_("reorder_threshold", "null")
        .execute()
    )
    return [
        LowStockStockItem(
            id=i["id"],
            name=i["name"],
            station=i["station"],
            current_stock=float(i["current_stock"]),
            reorder_threshold=float(i["reorder_threshold"]),
            unit=i["unit"],
        )
        for i in result.data
        if float(i["current_stock"]) <= float(i["reorder_threshold"])
    ]


@router.get("/stock-items", response_model=list[StockItemOut])
def list_stock_items(
    station: StockStation | None = Query(None),
    active_only: bool = Query(True),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("stock_items").select(
        "id, name, station, category, unit, ingredient_id, current_stock, reorder_threshold, "
        "active, needs_review, created_at, updated_at, ingredients(name, current_stock)"
    )
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
        .select(
            "id, name, station, category, unit, ingredient_id, current_stock, reorder_threshold, "
            "active, needs_review, created_at, updated_at, ingredients(name, current_stock)"
        )
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
        .select(
            "id, name, station, category, unit, ingredient_id, current_stock, reorder_threshold, "
            "active, needs_review, created_at, updated_at, ingredients(name, current_stock)"
        )
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

    # A linked item's actual stock is edited exclusively through Inventory
    # Count (Ending) / Receive Shipment (New Stocks) -- this avoids two
    # screens both being able to write the same ingredients.current_stock
    # number. Beginning/Usage/Notes/needs_verification are informational
    # only (never touch current_stock) and stay recordable here regardless.
    if stock_item["ingredient_id"] and (body.new_stocks is not None or body.ending is not None):
        raise HTTPException(
            status_code=400,
            detail="This item is linked to a recipe ingredient -- edit its stock via Inventory Count "
            "(Ending) or Receive Shipment (New Stocks), not here.",
        )

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

    # Only reachable for unlinked items now -- a linked item with ending/
    # new_stocks set was already rejected above, so these two current_stock-
    # mutation paths (apply_ingredient_count / apply_inventory_movement) stay
    # exclusively wired to Inventory Count / Receive Shipment respectively.
    if not stock_item["ingredient_id"]:
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
