"""Physical stock count tool: digitizes the client's 4 handwritten daily
station stock sheets (New Stocks / Beginning / Usage / Ending format).

As of 0028, these four numbers are auto-computed rather than typed by hand:
  - Beginning carries forward from yesterday's computed Ending.
  - New Stocks sums today's delivery movements for this item.
  - Usage sums today's sale-driven consumption (via stock_consumption_rules,
    deducted at checkout the same way recipe_items deducts ingredients) plus
    today's logged losses.
  - Ending is the live running current_stock (ingredients.current_stock for
    a linked item, stock_items.current_stock for an unlinked one) -- kept
    accurate by the same movements Beginning/New Stocks/Usage are summed
    from, so all four are mathematically consistent by construction.

Staff no longer type these fields directly -- they review the computed
list and, only when something looks wrong, "flag" a field via
POST /stock-items/{id}/field-override, which requires a reason and writes
an audited correction through the same current_stock-mutation paths
Inventory Count/Receive Shipment already use (apply_ingredient_count /
apply_inventory_movement / apply_stock_item_count below), never a silent
overwrite.

For a stock item that IS a recipe ingredient, this router still never edits
ingredients.current_stock directly -- every mutation (sale consumption,
delivery, count correction) funnels through the same shared functions
Inventory Count and Receive Shipment already own, so there is exactly one
writer of that number regardless of which page/flow touched it.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc, today_ph
from app.routers.inventory_movements import apply_inventory_movement
from app.schemas import (
    FieldOverride,
    LowStockStockItem,
    StockConsumptionRuleCreate,
    StockConsumptionRuleOut,
    StockConsumptionRuleUpdate,
    StockItemCreate,
    StockItemDailySummary,
    StockItemFieldOverrideRequest,
    StockItemNotesUpdate,
    StockItemOut,
    StockItemUpdate,
    StockStation,
)

router = APIRouter(tags=["stock-items"])

_stock_consumption_supported: bool | None = None


def _stock_consumption_supported_check(supabase) -> bool:
    """Migration 0028 feature-detection, same pattern as transactions.py's
    other _*_supported_check functions -- this repo has a documented
    history of migration DDL not applying cleanly, so every column/table
    added since is guarded rather than assumed present."""
    global _stock_consumption_supported
    if _stock_consumption_supported is None:
        try:
            supabase.table("stock_consumption_rules").select("id").limit(1).execute()
            _stock_consumption_supported = True
        except APIError:
            _stock_consumption_supported = False
    return _stock_consumption_supported


_OVERRIDE_FIELDS = ("beginning", "new_stocks", "usage", "ending")


def _is_override_marker_line(line: str) -> bool:
    """A field-override reason is stored as a `[field] reason` line inside
    the same stock_count_entries.notes column staff freely edit (see
    override_stock_item_field below) -- these two helpers keep that
    bookkeeping out of what staff actually see/edit in the Notes box, and
    stop an unrelated notes save from silently wiping an override's audit
    trail."""
    stripped = line.strip()
    return any(stripped.startswith(f"[{field}]") for field in _OVERRIDE_FIELDS)


def _strip_override_markers(notes: str | None) -> str | None:
    if not notes:
        return notes
    clean = "\n".join(line for line in notes.split("\n") if not _is_override_marker_line(line))
    return clean or None


def _override_marker_lines(notes: str | None) -> list[str]:
    if not notes:
        return []
    return [line for line in notes.split("\n") if _is_override_marker_line(line)]


def _to_stock_item_out(row: dict) -> dict:
    ingredient = row.pop("ingredients", None) or {}
    row["ingredient_name"] = ingredient.get("name")
    row["ingredient_current_stock"] = ingredient.get("current_stock")
    return row


def _to_rule_out(row: dict) -> dict:
    size = row.pop("product_sizes", None) or {}
    product = (size or {}).pop("products", None) or {}
    row["size_label"] = size.get("size_label")
    row["product_name"] = product.get("name")
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


@router.post("/stock-items", response_model=StockItemOut)
def create_stock_item(body: StockItemCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "stocker")
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
    require_role(user, "manager", "executive", "stocker")
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


# ---------------------------------------------------------------------------
# Sale-driven consumption -- called from transactions.py's
# _create_transaction_row / void_transaction, same call shape as
# _adjust_ingredients_for_size.
# ---------------------------------------------------------------------------


def _apply_stock_item_sale_delta(
    supabase, stock_item: dict, quantity: float, sign: int, employee_id: str, transaction_id: str
) -> None:
    movement_type = "sale_consumption" if sign < 0 else "sale_consumption_reversal"
    ingredient_id = stock_item.get("ingredient_id")
    # reference_id is FK'd to transfers(id) (0015) -- it can't hold a
    # transaction id, so the link is kept in reason text instead.
    apply_inventory_movement(
        supabase,
        ingredient_id,
        movement_type,
        quantity,
        employee_id,
        stock_item_id=None if ingredient_id else stock_item["id"],
        reason=f"Sale transaction {transaction_id}",
    )


def adjust_stock_items_for_product_unit(
    supabase, product_size_id: str, quantity: float, sign: int, employee_id: str, transaction_id: str
) -> None:
    """per_product_unit rules matching this size -- called once per
    non-bundle transaction item, same call site as
    _adjust_ingredients_for_size."""
    if not _stock_consumption_supported_check(supabase):
        return
    rules = (
        supabase.table("stock_consumption_rules")
        .select("id, qty_per_unit, stock_items(id, ingredient_id)")
        .eq("trigger_type", "per_product_unit")
        .eq("product_size_id", product_size_id)
        .eq("active", True)
        .execute()
    )
    for rule in rules.data:
        stock_item = rule["stock_items"]
        if not stock_item:
            continue
        delta = float(rule["qty_per_unit"]) * quantity
        _apply_stock_item_sale_delta(supabase, stock_item, delta, sign, employee_id, transaction_id)


def adjust_stock_items_for_transaction(
    supabase,
    order_type: str | None,
    guest_count: int | None,
    sign: int,
    employee_id: str,
    transaction_id: str,
) -> None:
    """per_transaction rules -- called ONCE per transaction (not per item),
    after the item loop. Matches rules with order_type IS NULL (applies to
    both dine_in and takeout) OR order_type = this transaction's."""
    if not _stock_consumption_supported_check(supabase):
        return
    rules = (
        supabase.table("stock_consumption_rules")
        .select("id, qty_per_unit, scale_by_guest_count, order_type, stock_items(id, ingredient_id)")
        .eq("trigger_type", "per_transaction")
        .eq("active", True)
        .execute()
    )
    for rule in rules.data:
        if rule["order_type"] is not None and rule["order_type"] != order_type:
            continue
        stock_item = rule["stock_items"]
        if not stock_item:
            continue
        multiplier = (guest_count or 1) if rule["scale_by_guest_count"] else 1
        delta = float(rule["qty_per_unit"]) * multiplier
        _apply_stock_item_sale_delta(supabase, stock_item, delta, sign, employee_id, transaction_id)


# ---------------------------------------------------------------------------
# Computed daily summary (New Stocks / Beginning / Usage / Ending)
# ---------------------------------------------------------------------------


def _current_running_stock(stock_item: dict) -> float:
    if stock_item.get("ingredient_id"):
        ingredient = stock_item.get("ingredients") or {}
        return float(ingredient.get("current_stock") or 0)
    return float(stock_item["current_stock"])


def _movement_target_key(stock_item: dict) -> str:
    """The id sale/loss/delivery movements for this item are actually
    filed under -- the linked ingredient's id, or the stock item's own id
    when unlinked."""
    return stock_item["ingredient_id"] if stock_item.get("ingredient_id") else stock_item["id"]


def _sum_new_stocks_and_usage(movements: list[dict], losses: list[dict]) -> tuple[float, float]:
    new_stocks = sum(float(m["quantity"]) for m in movements if m["type"] in ("delivery", "trans_in"))
    sale_usage = sum(float(m["quantity"]) for m in movements if m["type"] == "sale_consumption")
    sale_reversal = sum(float(m["quantity"]) for m in movements if m["type"] == "sale_consumption_reversal")
    loss_usage = sum(float(l["quantity"]) for l in losses if not l.get("skip_stock_deduction"))
    usage = sale_usage - sale_reversal + loss_usage
    return new_stocks, usage


def _build_daily_summaries(
    supabase, items: list[dict], count_date: date, entry_column: str = "stock_item_id"
) -> list[dict]:
    """Batched version of the per-item computation: a station grid can hold
    ~200 rows, and issuing 4-6 sequential queries per item (one station load
    -> 800-1200 round trips) made the page take 45s+ to load. This issues a
    fixed handful of queries scoped to the whole item set instead, then
    computes each item's four numbers in memory.

    entry_column selects which stock_count_entries column the four numbers
    are read from/keyed by (0030 made that table polymorphic the same way
    inventory_movements/loss_records already were) -- "stock_item_id" for a
    Station Items grid (the default, unchanged from before 0030), or
    "ingredient_id" when the caller is inventory.py's plain-ingredient
    summary (see _ingredient_summary_items there). Returns plain dicts
    (id/count_date/beginning/.../overrides) rather than a pydantic model
    directly, since the two callers key the row differently
    (stock_item_id vs ingredient_id) -- each wraps the dict in its own
    response schema."""
    if not items:
        return []

    stock_item_ids = [i["id"] for i in items if not i.get("ingredient_id")]
    ingredient_ids = [i["ingredient_id"] for i in items if i.get("ingredient_id")]
    item_ids = [i["id"] for i in items]

    start, end = ph_day_bounds_utc(count_date)

    movements_by_key: dict[str, list[dict]] = defaultdict(list)
    losses_by_key: dict[str, list[dict]] = defaultdict(list)
    for col, ids in (("stock_item_id", stock_item_ids), ("ingredient_id", ingredient_ids)):
        if not ids:
            continue
        moves = (
            supabase.table("inventory_movements")
            .select(f"type, quantity, {col}")
            .in_(col, ids)
            .gte("created_at", start)
            .lte("created_at", end)
            .execute()
        ).data
        for m in moves:
            movements_by_key[m[col]].append(m)

        losses = (
            supabase.table("loss_records")
            .select(f"quantity, skip_stock_deduction, {col}")
            .in_(col, ids)
            .gte("created_at", start)
            .lte("created_at", end)
            .execute()
        ).data
        for l in losses:
            losses_by_key[l[col]].append(l)

    # Most recent prior-day Ending per item, for carry-forward Beginning.
    prior_rows = (
        supabase.table("stock_count_entries")
        .select(f"{entry_column}, count_date, ending")
        .in_(entry_column, item_ids)
        .lt("count_date", count_date.isoformat())
        .order("count_date", desc=True)
        .execute()
    ).data
    prior_ending_by_item: dict[str, float] = {}
    for row in prior_rows:
        if row["ending"] is None or row[entry_column] in prior_ending_by_item:
            continue
        prior_ending_by_item[row[entry_column]] = float(row["ending"])

    today_rows = (
        supabase.table("stock_count_entries")
        .select("*")
        .in_(entry_column, item_ids)
        .eq("count_date", count_date.isoformat())
        .execute()
    ).data
    today_entry_by_item = {row[entry_column]: row for row in today_rows}

    summaries = []
    for item in items:
        key = _movement_target_key(item)
        new_stocks, usage = _sum_new_stocks_and_usage(movements_by_key.get(key, []), losses_by_key.get(key, []))
        ending = _current_running_stock(item)

        if item["id"] in prior_ending_by_item:
            beginning, beginning_source = prior_ending_by_item[item["id"]], "carry_forward"
        else:
            # No history: derive start-of-day stock by reversing today's
            # already-applied movements from the live current value, so
            # Beginning + New Stocks - Usage = Ending holds even on day 1.
            beginning, beginning_source = ending - new_stocks + usage, "fallback"

        entry = today_entry_by_item.get(item["id"])
        overrides: dict[str, FieldOverride] = {}
        if entry:
            by = entry.get("recorded_by")
            at = entry.get("updated_at") or entry.get("created_at")
            notes = entry.get("notes") or ""
            for field in ("beginning", "new_stocks", "usage", "ending"):
                value = entry.get(field)
                if value is None:
                    continue
                reason = "(no reason recorded)"
                marker = f"[{field}]"
                for line in notes.split("\n"):
                    if line.strip().startswith(marker):
                        reason = line.strip()[len(marker):].strip()
                        break
                overrides[field] = FieldOverride(value=float(value), reason=reason, by=by, at=at)
                if field == "beginning":
                    beginning, beginning_source = float(value), "carry_forward"
                elif field == "new_stocks":
                    new_stocks = float(value)
                elif field == "usage":
                    usage = float(value)
                elif field == "ending":
                    ending = float(value)

        summaries.append(
            {
                "id": item["id"],
                "count_date": count_date,
                "beginning": beginning,
                "beginning_source": beginning_source,
                "new_stocks": new_stocks,
                "usage": usage,
                "ending": ending,
                "notes": _strip_override_markers(entry.get("notes")) if entry else None,
                "needs_verification": bool(entry.get("needs_verification")) if entry else False,
                "overrides": overrides,
            }
        )
    return summaries


def _to_stock_item_summary(d: dict) -> StockItemDailySummary:
    return StockItemDailySummary(stock_item_id=d["id"], **{k: v for k, v in d.items() if k != "id"})


def _build_daily_summary(supabase, stock_item: dict, count_date: date) -> StockItemDailySummary:
    """Single-item convenience wrapper around _build_daily_summaries, for
    the field-override endpoint's before/after computation."""
    return _to_stock_item_summary(_build_daily_summaries(supabase, [stock_item], count_date)[0])


def _upsert_override_entry(
    supabase,
    entry_column: str,
    entry_id: str,
    count_date: date,
    field: str,
    corrected_value: float,
    reason: str,
    employee_id: str,
) -> None:
    """Persists a field correction on stock_count_entries (keyed by either
    stock_item_id or ingredient_id, see 0030) so it survives a reload and is
    distinguishable from the auto-computed value (see _build_daily_summaries'
    overrides parsing). Shared by both Station Items' and plain ingredients'
    field-override endpoints."""
    existing = (
        supabase.table("stock_count_entries")
        .select("id, notes")
        .eq(entry_column, entry_id)
        .eq("count_date", count_date.isoformat())
        .execute()
    )
    marker = f"[{field}] {reason}"
    if existing.data:
        prior_notes = existing.data[0].get("notes") or ""
        lines = [l for l in prior_notes.split("\n") if not l.strip().startswith(f"[{field}]")]
        lines.append(marker)
        supabase.table("stock_count_entries").update(
            {field: corrected_value, "notes": "\n".join(lines), "updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", existing.data[0]["id"]).execute()
    else:
        supabase.table("stock_count_entries").insert(
            {
                entry_column: entry_id,
                "count_date": count_date.isoformat(),
                "recorded_by": employee_id,
                field: corrected_value,
                "notes": marker,
            }
        ).execute()


@router.get("/stock-items/count-entries", response_model=list[StockItemDailySummary])
def list_count_entries(
    station: StockStation = Query(...),
    count_date: date | None = Query(None, alias="date"),
    user: CurrentUser = Depends(get_current_user),
):
    """Hydrates a station's grid for a given day (defaults today) with the
    computed New Stocks/Beginning/Usage/Ending -- see module docstring."""
    if count_date is None:
        count_date = today_ph()
    supabase = get_supabase()
    items = (
        supabase.table("stock_items")
        .select("id, ingredient_id, current_stock, ingredients(current_stock)")
        .eq("station", station)
        .execute()
    ).data
    return [_to_stock_item_summary(s) for s in _build_daily_summaries(supabase, items, count_date)]


@router.post("/stock-items/{stock_item_id}/notes")
def update_stock_item_notes(
    stock_item_id: str,
    body: StockItemNotesUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    """Notes/needs-verification are the only fields still directly typed by
    staff -- the four numeric fields are computed (see list_count_entries)
    and only ever change via the flag/override endpoint below."""
    if body.recorded_by != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a note under another employee's id")
    supabase = get_supabase()
    count_date = body.count_date or today_ph()

    existing = (
        supabase.table("stock_count_entries")
        .select("id, notes")
        .eq("stock_item_id", stock_item_id)
        .eq("count_date", count_date.isoformat())
        .execute()
    )
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if body.notes is not None:
        # Re-append any existing field-override marker lines (see
        # _strip_override_markers) so saving the staff-visible Notes text --
        # which never contains those lines itself -- can't silently erase a
        # correction's audit trail.
        prior_notes = existing.data[0].get("notes") if existing.data else None
        marker_lines = _override_marker_lines(prior_notes)
        update_data["notes"] = "\n".join([body.notes, *marker_lines]) if marker_lines else body.notes
    if body.needs_verification is not None:
        update_data["needs_verification"] = body.needs_verification

    if existing.data:
        supabase.table("stock_count_entries").update(update_data).eq("id", existing.data[0]["id"]).execute()
    else:
        update_data.update(
            {"stock_item_id": stock_item_id, "count_date": count_date.isoformat(), "recorded_by": body.recorded_by}
        )
        supabase.table("stock_count_entries").insert(update_data).execute()
    return {"ok": True}


def apply_stock_item_count(
    supabase, stock_item_id: str, counted_stock: float, employee_id: str, reason: str | None = None
) -> dict:
    """Unlinked-item equivalent of apply_ingredient_count -- sets
    stock_items.current_stock directly to the counted/corrected value and,
    if it differs from the prior value, logs a count_adjustment movement
    with the reason, so the correction has a real audit trail."""
    existing = supabase.table("stock_items").select("current_stock").eq("id", stock_item_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Stock item not found")

    previous_stock = float(existing.data["current_stock"])
    variance = round(counted_stock - previous_stock, 4)

    supabase.table("stock_items").update(
        {"current_stock": counted_stock, "updated_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", stock_item_id).execute()

    movement = None
    if variance != 0:
        movement_reason = f"Stock count: {previous_stock} -> {counted_stock} (variance {variance:+})"
        if reason:
            movement_reason = f"{reason} -- {movement_reason}"
        movement_result = (
            supabase.table("inventory_movements")
            .insert(
                {
                    "stock_item_id": stock_item_id,
                    "type": "count_adjustment",
                    "quantity": abs(variance),
                    "reason": movement_reason,
                    "employee_id": employee_id,
                }
            )
            .execute()
        )
        movement = movement_result.data[0]
    return {"variance": variance, "movement": movement}


@router.post("/stock-items/{stock_item_id}/field-override", response_model=StockItemDailySummary)
def override_stock_item_field(
    stock_item_id: str,
    body: StockItemFieldOverrideRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Flag-to-edit: staff review the auto-computed New Stocks/Beginning/
    Usage/Ending and only reach this endpoint when one looks wrong. Every
    call requires a reason and writes an audited correction -- never a
    silent overwrite of the computed value."""
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a correction under another employee's id")

    supabase = get_supabase()
    item_result = (
        supabase.table("stock_items")
        .select("id, ingredient_id, current_stock, ingredients(current_stock)")
        .eq("id", stock_item_id)
        .maybe_single()
        .execute()
    )
    if not item_result or not item_result.data:
        raise HTTPException(status_code=404, detail="Stock item not found")
    stock_item = item_result.data
    count_date = body.count_date or today_ph()

    if body.field == "beginning":
        # Beginning is informational carry-forward context -- it has never
        # driven current_stock, and shouldn't start now. Just record it.
        pass
    elif body.field == "ending":
        if stock_item.get("ingredient_id"):
            # Deferred import: inventory.py imports get_low_stock_stock_items
            # from this module, so a module-level import here would be
            # circular. Both routers are already fully loaded by the time
            # any request handler actually runs.
            from app.routers.inventory import apply_ingredient_count

            apply_ingredient_count(
                supabase, stock_item["ingredient_id"], body.corrected_value, body.employee_id, note=body.reason
            )
        else:
            apply_stock_item_count(supabase, stock_item_id, body.corrected_value, body.employee_id, body.reason)
    else:
        # new_stocks / usage: figure out how current_stock itself needs to
        # move so the corrected value is what future summaries compute.
        # More New Stocks than tracked, or less Usage than tracked, both
        # mean real stock is HIGHER than the running number implies (add);
        # the opposite direction means it's LOWER (subtract). This mirrors
        # apply_ingredient_count/apply_stock_item_count's own pattern
        # (direct current_stock assignment + a count_adjustment audit row
        # logged separately) rather than routing through
        # apply_inventory_movement's add/subtract type dispatch, which has
        # no "subtract" variant of count_adjustment to route through.
        auto = _build_daily_summary(supabase, stock_item, count_date)
        auto_value = auto.new_stocks if body.field == "new_stocks" else auto.usage
        field_delta = body.corrected_value - auto_value
        stock_delta = field_delta if body.field == "new_stocks" else -field_delta

        if stock_delta != 0:
            ingredient_id = stock_item.get("ingredient_id")
            table = "ingredients" if ingredient_id else "stock_items"
            target_id = ingredient_id or stock_item_id
            current = (
                supabase.table(table).select("current_stock").eq("id", target_id).maybe_single().execute()
            ).data
            new_stock = float(current["current_stock"]) + stock_delta
            supabase.table(table).update({"current_stock": new_stock}).eq("id", target_id).execute()
            supabase.table("inventory_movements").insert(
                {
                    "ingredient_id": ingredient_id,
                    "stock_item_id": None if ingredient_id else stock_item_id,
                    "type": "count_adjustment",
                    "quantity": abs(stock_delta),
                    "reason": f"{body.reason} -- {body.field} corrected to {body.corrected_value}",
                    "employee_id": body.employee_id,
                }
            ).execute()

    _upsert_override_entry(
        supabase, "stock_item_id", stock_item_id, count_date, body.field, body.corrected_value, body.reason, body.employee_id
    )

    refreshed = (
        supabase.table("stock_items")
        .select("id, ingredient_id, current_stock, ingredients(current_stock)")
        .eq("id", stock_item_id)
        .maybe_single()
        .execute()
    )
    return _build_daily_summary(supabase, refreshed.data, count_date)


# ---------------------------------------------------------------------------
# Consumption rules (0028) -- the recipe_items equivalent for stock items,
# managed from Manage Catalog. Manager/executive-gated like the rest of it.
# ---------------------------------------------------------------------------


@router.get("/stock-consumption-rules", response_model=list[StockConsumptionRuleOut])
def list_stock_consumption_rules(
    stock_item_id: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("stock_consumption_rules").select(
        "*, product_sizes(size_label, products(name))"
    )
    if stock_item_id:
        query = query.eq("stock_item_id", stock_item_id)
    result = query.order("created_at", desc=True).execute()
    return [_to_rule_out(row) for row in result.data]


@router.post("/stock-consumption-rules", response_model=StockConsumptionRuleOut)
def create_stock_consumption_rule(body: StockConsumptionRuleCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    if body.trigger_type == "per_product_unit" and not body.product_size_id:
        raise HTTPException(status_code=400, detail="product_size_id is required for a per-product-unit rule")
    if body.trigger_type == "per_transaction" and body.product_size_id:
        raise HTTPException(status_code=400, detail="product_size_id must be omitted for a per-transaction rule")

    result = (
        supabase.table("stock_consumption_rules")
        .insert(
            {
                "stock_item_id": body.stock_item_id,
                "trigger_type": body.trigger_type,
                "product_size_id": body.product_size_id,
                "order_type": body.order_type,
                "qty_per_unit": body.qty_per_unit,
                "scale_by_guest_count": body.scale_by_guest_count,
                "active": body.active,
                "notes": body.notes,
            }
        )
        .select("*, product_sizes(size_label, products(name))")
        .execute()
    )
    return _to_rule_out(result.data[0])


@router.patch("/stock-consumption-rules/{rule_id}", response_model=StockConsumptionRuleOut)
def update_stock_consumption_rule(
    rule_id: str, body: StockConsumptionRuleUpdate, user: CurrentUser = Depends(get_current_user)
):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = (
        supabase.table("stock_consumption_rules")
        .update(update_data)
        .eq("id", rule_id)
        .select("*, product_sizes(size_label, products(name))")
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Consumption rule not found")
    return _to_rule_out(result.data[0])


@router.delete("/stock-consumption-rules/{rule_id}")
def delete_stock_consumption_rule(rule_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    supabase.table("stock_consumption_rules").delete().eq("id", rule_id).execute()
    return {"ok": True}
