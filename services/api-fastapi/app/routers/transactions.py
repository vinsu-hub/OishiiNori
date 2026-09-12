from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role, verify_employee_pin
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc, today_ph
from app.routers.reservations import _blocking_reservation, _now_ph, _table_by_pos_number
from app.routers.stock_items import adjust_stock_items_for_product_unit, adjust_stock_items_for_transaction
from app.schemas import (
    BundleFulfillmentRequest,
    BundleFulfillmentResponse,
    CreateTransactionRequest,
    DeductedIngredient,
    KitchenStatusUpdateRequest,
    SwitchTableRequest,
    TransactionResponse,
    VoidTransactionRequest,
)

router = APIRouter(tags=["transactions"])

KITCHEN_STATUS_ORDER = ["queued", "preparing", "ready", "completed"]


def _get_vat_rate(supabase) -> float:
    """Admin-editable VAT rate (settings.py) -- previously a hardcoded 0.12
    constant duplicated here and in the frontend's VAT_RATE_PREVIEW, with a
    comment admitting the two "must be kept in sync" by hand. Read fresh
    each call (a single-row lookup) rather than cached, same as hr.py's
    _get_pay_multiplier_rules() re-reads its own configurable-rules table
    on every use."""
    result = supabase.table("business_settings").select("vat_rate").eq("id", 1).single().execute()
    return float(result.data["vat_rate"])

# --------------------------------------------------------------------------
# Feature detection for migration 0014 (kitchen_status / bundle_fulfillments)
# --------------------------------------------------------------------------
# JUDGMENT CALL, flagged prominently in the handoff report: this backend's
# session was unable to apply supabase/migrations/0014_phase2_order_
# fulfillment.sql to the live DB (a tool-level permission block on running
# DDL against the live database, not a design decision). Rather than making
# order creation / recipe deduction -- the core, most-tested feature --
# hard-fail because of that, this module feature-detects whether the
# migration has been applied and degrades the newer KDS/bundle-fulfillment
# endpoints to a clear 501 if it hasn't, while the core sale/void/recipe-
# deduction flow works either way.
_kitchen_status_supported: bool | None = None
_bundle_fulfillments_supported: bool | None = None
_held_ingredients_supported: bool | None = None
_transaction_item_addons_supported: bool | None = None
_transaction_order_context_supported: bool | None = None
_transaction_order_number_supported: bool | None = None
_business_days_supported: bool | None = None
_transaction_card_vat_supported: bool | None = None


def _business_days_supported_check(supabase) -> bool:
    """Same fail-open-until-migrated pattern as _kitchen_status_supported_check
    -- lets this endpoint keep working before migration 0035 is applied,
    then starts enforcing the Business Day lock once the table exists."""
    global _business_days_supported
    if _business_days_supported is None:
        try:
            supabase.table("business_days").select("id").limit(1).execute()
            _business_days_supported = True
        except APIError:
            _business_days_supported = False
    return _business_days_supported


def _kitchen_status_supported_check(supabase) -> bool:
    global _kitchen_status_supported
    if _kitchen_status_supported is None:
        try:
            supabase.table("transactions").select("kitchen_status").limit(1).execute()
            _kitchen_status_supported = True
        except APIError:
            _kitchen_status_supported = False
    return _kitchen_status_supported


def _bundle_fulfillments_supported_check(supabase) -> bool:
    global _bundle_fulfillments_supported
    if _bundle_fulfillments_supported is None:
        try:
            supabase.table("bundle_fulfillments").select("id").limit(1).execute()
            _bundle_fulfillments_supported = True
        except APIError:
            _bundle_fulfillments_supported = False
    return _bundle_fulfillments_supported


def _held_ingredients_supported_check(supabase) -> bool:
    """Migration 0019 feature-detection, same pattern as the two checks
    above -- this dev environment has a documented history of migration DDL
    silently failing to apply (see 0014's handoff notes), so every column
    added since is guarded rather than assumed present."""
    global _held_ingredients_supported
    if _held_ingredients_supported is None:
        try:
            supabase.table("transaction_items").select("held_ingredients").limit(1).execute()
            _held_ingredients_supported = True
        except APIError:
            _held_ingredients_supported = False
    return _held_ingredients_supported


def _transaction_item_addons_supported_check(supabase) -> bool:
    """Migration 0026 feature-detection, same pattern as the checks above."""
    global _transaction_item_addons_supported
    if _transaction_item_addons_supported is None:
        try:
            supabase.table("transaction_item_addons").select("id").limit(1).execute()
            _transaction_item_addons_supported = True
        except APIError:
            _transaction_item_addons_supported = False
    return _transaction_item_addons_supported


def _transaction_order_context_supported_check(supabase) -> bool:
    """Migration 0027 feature-detection, same pattern as the checks above."""
    global _transaction_order_context_supported
    if _transaction_order_context_supported is None:
        try:
            supabase.table("transactions").select(
                "order_type, table_number, guest_count, payment_method"
            ).limit(1).execute()
            _transaction_order_context_supported = True
        except APIError:
            _transaction_order_context_supported = False
    return _transaction_order_context_supported


def _transaction_order_number_supported_check(supabase) -> bool:
    """Migration 0033 feature-detection, same pattern as the checks above."""
    global _transaction_order_number_supported
    if _transaction_order_number_supported is None:
        try:
            supabase.table("transactions").select("order_number").limit(1).execute()
            _transaction_order_number_supported = True
        except APIError:
            _transaction_order_number_supported = False
    return _transaction_order_number_supported


def _transaction_card_vat_supported_check(supabase) -> bool:
    """Migration 0039 feature-detection, same pattern as the checks above --
    card_type (debit/credit prompt) and force_vat_exempt (POS VAT/Non-VAT
    toggle)."""
    global _transaction_card_vat_supported
    if _transaction_card_vat_supported is None:
        try:
            supabase.table("transactions").select("card_type, force_vat_exempt").limit(1).execute()
            _transaction_card_vat_supported = True
        except APIError:
            _transaction_card_vat_supported = False
    return _transaction_card_vat_supported


def _attach_item_addons(supabase, items: list[dict]) -> None:
    """Batch-fetches transaction_item_addons (joined to menu_addons for the
    display name) for the given transaction_items and attaches them as
    item['addons'] -- mutates items in place. No-ops (leaves addons: [])
    when migration 0026 hasn't been applied yet."""
    for item in items:
        item.setdefault("addons", [])
    if not items or not _transaction_item_addons_supported_check(supabase):
        return
    item_ids = [i["id"] for i in items]
    addons_result = (
        supabase.table("transaction_item_addons")
        .select("*, menu_addons(name)")
        .in_("transaction_item_id", item_ids)
        .execute()
    )
    addons_by_item: dict[str, list] = defaultdict(list)
    for row in addons_result.data:
        addon_info = row.pop("menu_addons", None) or {}
        row["addon_name"] = addon_info.get("name")
        addons_by_item[row["transaction_item_id"]].append(row)
    for item in items:
        item["addons"] = addons_by_item.get(item["id"], [])


_MIGRATION_PENDING_DETAIL = (
    "This feature requires supabase/migrations/0014_phase2_order_fulfillment.sql "
    "to be applied to the live database. It has not been applied yet (blocked at "
    "build time by a tool permission gate on running DDL against the live DB -- "
    "see the Phase 2 backend handoff report). Apply the migration, then this "
    "endpoint will work without any code changes."
)


def _adjust_ingredients_for_size(
    supabase,
    product_size_id: str,
    quantity: float,
    sign: int,
    employee_id: str,
    transaction_id: str,
    held_ingredient_names: list[str] | None = None,
) -> dict[str, float]:
    """Applies recipe-based stock changes for one product_size sold/restored.
    sign=-1 deducts (a sale), sign=1 restores (a void). Returns the ingredient
    deltas actually applied (id -> signed delta), for logging/response use.

    qty_per_serving is used LITERALLY, per task spec -- it is already
    pre-scaled per size tier in the seed data; scale_factor on product_sizes
    is documentation-only and must not be applied again here.

    held_ingredient_names: ingredients the customer asked to hold for this
    line (transaction_items.held_ingredients stores names, not ids -- see
    POSTerminal.tsx's toggleHeldIngredient). A held ingredient was never
    actually used, so it's skipped entirely here -- both on the original
    deduct (sign=-1) and, symmetrically, on a later void's restore
    (sign=+1), since there's nothing to restore for stock that was never
    touched. Previously this parameter didn't exist and every recipe line
    was deducted unconditionally regardless of what was held, silently
    manufacturing false "shrinkage" that only surfaced later during a
    manual count.

    employee_id/transaction_id (0030): every delta is also logged as a
    sale_consumption/sale_consumption_reversal inventory_movements row --
    the same movement types Station Items' sale-driven deduction already
    uses (0028). Previously this function only mutated current_stock with
    no audit trail at all (see 0028's own comment), which meant recipe
    ingredients had no summable "Usage" the way Station Items does. The
    insert is batched (one call for the whole product_size, not one per
    ingredient) for the same hot-path reason the read above is batched.
    """
    held = set(held_ingredient_names or [])
    recipe_result = (
        supabase.table("recipe_items")
        .select("ingredient_id, qty_per_serving, ingredients(name)")
        .eq("product_size_id", product_size_id)
        .execute()
    )
    recipe_rows = [r for r in recipe_result.data if r["ingredients"]["name"] not in held]
    if not recipe_rows:
        return {}

    # Batch the read: one query for every ingredient's current stock instead
    # of one query per recipe line -- this function runs on every sale,
    # void, and bundle-fulfillment, so the per-line query used to fire on
    # the checkout hot path once per recipe ingredient (see
    # OPTIMIZATION_PLAN.md item 1). recipe_items has a unique constraint on
    # (product_size_id, ingredient_id), so ingredient_id can't repeat within
    # recipe_rows -- no stale-read risk from batching this read. The write
    # stays per-row: PostgREST has no batched "add a different delta to
    # each row" primitive without a raw SQL RPC.
    ingredient_ids = [r["ingredient_id"] for r in recipe_rows]
    stock_result = supabase.table("ingredients").select("id, current_stock").in_("id", ingredient_ids).execute()
    current_stock_by_id = {row["id"]: float(row["current_stock"]) for row in stock_result.data}

    deltas: dict[str, float] = {}
    movement_rows: list[dict] = []
    movement_type = "sale_consumption" if sign < 0 else "sale_consumption_reversal"
    for recipe_item in recipe_rows:
        ingredient_id = recipe_item["ingredient_id"]
        delta_qty = float(recipe_item["qty_per_serving"]) * quantity * sign
        current_stock = current_stock_by_id.get(ingredient_id, 0.0)
        new_stock = current_stock + delta_qty
        supabase.table("ingredients").update({"current_stock": new_stock}).eq("id", ingredient_id).execute()
        deltas[ingredient_id] = delta_qty
        if delta_qty != 0:
            movement_rows.append(
                {
                    "ingredient_id": ingredient_id,
                    "type": movement_type,
                    "quantity": abs(delta_qty),
                    "reason": f"Recipe sale -- transaction {transaction_id}",
                    "employee_id": employee_id,
                }
            )
    if movement_rows:
        supabase.table("inventory_movements").insert(movement_rows).execute()
    return deltas


def _bundle_fulfilled_item_ids(supabase, item_ids: list[str]) -> set[str]:
    """Which of these transaction_item ids already have bundle_fulfillments
    rows -- the real source of truth for "has the kitchen logged this
    bundle's rolls yet", surfaced so the frontend doesn't have to track it
    in local-only state (which a reload would wipe). A bundle item either
    has 0 or the full required set of fulfillment rows (bundle_fulfillment
    requires the submitted total to match exactly in one shot), so
    existence alone is sufficient -- no partial-fulfillment state exists.
    """
    if not item_ids or not _bundle_fulfillments_supported_check(supabase):
        return set()
    # Chunked so the underlying PostgREST `in.(id1,id2,...)` filter never
    # risks exceeding URL/header length limits as order history grows --
    # list_transactions's unpaginated, no-date-filter call path (Kitchen
    # Display) can hand this the full transaction-item history.
    fulfilled: set[str] = set()
    chunk_size = 200
    for i in range(0, len(item_ids), chunk_size):
        chunk = item_ids[i : i + chunk_size]
        result = (
            supabase.table("bundle_fulfillments")
            .select("transaction_item_id")
            .in_("transaction_item_id", chunk)
            .execute()
        )
        fulfilled.update(row["transaction_item_id"] for row in result.data)
    return fulfilled


def _fetch_transaction_with_items(supabase, transaction_id: str) -> dict | None:
    result = supabase.table("transactions").select("*").eq("id", transaction_id).maybe_single().execute()
    if not result or not result.data:
        return None
    transaction = result.data
    items_result = (
        supabase.table("transaction_items").select("*").eq("transaction_id", transaction_id).execute()
    )
    items = items_result.data
    fulfilled_ids = _bundle_fulfilled_item_ids(supabase, [i["id"] for i in items])
    for item in items:
        item["bundle_fulfilled"] = item["id"] in fulfilled_ids
    _attach_item_addons(supabase, items)
    transaction["items"] = items
    transaction.setdefault("kitchen_status", "queued")
    transaction.setdefault("order_number", None)
    transaction.setdefault("order_type", None)
    transaction.setdefault("table_number", None)
    transaction.setdefault("guest_count", None)
    transaction.setdefault("payment_method", None)
    transaction.setdefault("card_type", None)
    transaction.setdefault("force_vat_exempt", False)
    return transaction


def _create_transaction_row(
    supabase,
    employee_id: str,
    items: list,
    discount_type_id: str | None = None,
    is_owner_request: bool = False,
    owner_request_by: str | None = None,
    owner_request_note: str | None = None,
    order_type: str | None = None,
    table_number: int | None = None,
    guest_count: int | None = None,
    payment_method: str | None = None,
    card_type: str | None = None,
    force_vat_exempt: bool = False,
) -> TransactionResponse:
    """Insert a transaction + items, deduct non-bundle recipe ingredients,
    and compute discount/tax. Shared by POS sale creation (create_transaction
    below) and digital-menu order approval (digital_menu.py's approve
    endpoint) -- the only difference between those two callers is how
    employee_id/items are sourced (a logged-in cashier vs. an approved
    customer order), not how a sale gets recorded.

    Bundle line items (product.is_bundle=true) are NOT deducted here -- per
    spec, a bundle's actual ingredient consumption is only known once the
    kitchen logs which real rolls went into it, via the bundle-fulfillment
    endpoint below. This matches recipe_items having zero rows for a
    bundle's product_size, so the generic per-size deduction would no-op
    anyway; the skip is made explicit for clarity and to avoid a wasted
    query per bundle item.
    """
    if not items:
        raise HTTPException(status_code=400, detail="Transaction must have at least one item")

    size_ids = [item.product_size_id for item in items]
    sizes_result = (
        supabase.table("product_sizes")
        .select("*, products(id, name, is_bundle, active)")
        .in_("id", size_ids)
        .execute()
    )
    sizes_by_id = {s["id"]: s for s in sizes_result.data}
    missing = [sid for sid in size_ids if sid not in sizes_by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"Product sizes not found: {missing}")

    # Add-ons (0026): never trust a client-sent price -- look up the real
    # price/active flag from menu_addons, same posture as digital_menu.py's
    # submit_digital_order. Unlike that endpoint, addons here are folded
    # into `subtotal` below *before* discount/tax is computed, so an addon
    # on a discounted item is discounted/taxed consistently with the rest
    # of the line instead of needing a post-hoc total patch.
    addon_ids = [a.addon_id for item in items for a in item.addons]
    addons_by_id: dict[str, dict] = {}
    if addon_ids:
        addons_result = (
            supabase.table("menu_addons").select("id, price, active").in_("id", addon_ids).execute()
        )
        addons_by_id = {a["id"]: a for a in addons_result.data}
        missing_addons = [aid for aid in addon_ids if aid not in addons_by_id]
        if missing_addons:
            raise HTTPException(status_code=404, detail=f"Add-ons not found: {missing_addons}")
        inactive_addons = [aid for aid in addon_ids if not addons_by_id[aid]["active"]]
        if inactive_addons:
            raise HTTPException(status_code=400, detail=f"Add-ons no longer available: {inactive_addons}")

    discount = None
    discount_amount = 0.0
    vat_exempt = False
    if discount_type_id:
        discount_result = (
            supabase.table("discount_types")
            .select("*")
            .eq("id", discount_type_id)
            .maybe_single()
            .execute()
        )
        if not discount_result or not discount_result.data:
            raise HTTPException(status_code=404, detail="Discount type not found")
        discount = discount_result.data
        if not discount["active"]:
            raise HTTPException(status_code=400, detail="Discount type is not active")
        vat_exempt = discount["vat_exempt"] or force_vat_exempt
    elif force_vat_exempt:
        vat_exempt = True

    now_iso = datetime.now(timezone.utc).isoformat()
    insert_payload = {
        "employee_id": employee_id,
        "status": "open",
        "opened_at": now_iso,
        "total_amount": 0,
        "is_owner_request": is_owner_request,
        "owner_request_by": owner_request_by,
        "owner_request_note": owner_request_note,
    }
    if _kitchen_status_supported_check(supabase):
        insert_payload["kitchen_status"] = "queued"
        insert_payload["kitchen_status_updated_at"] = now_iso
    if _transaction_order_context_supported_check(supabase):
        insert_payload["order_type"] = order_type
        insert_payload["table_number"] = table_number
        insert_payload["guest_count"] = guest_count
        insert_payload["payment_method"] = payment_method
    if _transaction_card_vat_supported_check(supabase):
        insert_payload["card_type"] = card_type
        insert_payload["force_vat_exempt"] = force_vat_exempt

    transaction_insert = supabase.table("transactions").insert(insert_payload).execute()
    transaction = transaction_insert.data[0]
    transaction_id = transaction["id"]

    held_ingredients_supported = _held_ingredients_supported_check(supabase)

    addons_supported = _transaction_item_addons_supported_check(supabase)

    subtotal = 0.0
    item_rows = []
    for item in items:
        size = sizes_by_id[item.product_size_id]
        unit_price = float(size["price"])
        subtotal += unit_price * item.quantity
        for addon in item.addons:
            subtotal += float(addons_by_id[addon.addon_id]["price"]) * addon.quantity
        row = {
            "transaction_id": transaction_id,
            "product_size_id": item.product_size_id,
            "quantity": item.quantity,
            "unit_price": unit_price,
        }
        if held_ingredients_supported:
            row["held_ingredients"] = item.held_ingredients
        item_rows.append(row)

    if any(item.addons for item in items) and addons_supported:
        # Insert one row at a time here (rather than the usual single bulk
        # insert) -- each transaction_items row's real id is needed
        # immediately after, to attach that specific item's addon rows, and
        # a bulk insert's returned row order relative to the input isn't a
        # guarantee worth relying on.
        inserted_items = []
        for item, row in zip(items, item_rows):
            inserted = supabase.table("transaction_items").insert(row).execute().data[0]
            inserted_items.append(inserted)
            addon_rows = [
                {
                    "transaction_item_id": inserted["id"],
                    "addon_id": addon.addon_id,
                    "quantity": addon.quantity,
                    "unit_price": float(addons_by_id[addon.addon_id]["price"]),
                }
                for addon in item.addons
            ]
            if addon_rows:
                supabase.table("transaction_item_addons").insert(addon_rows).execute()
    else:
        inserted_items = supabase.table("transaction_items").insert(item_rows).execute().data
    _attach_item_addons(supabase, inserted_items)

    for item in items:
        size = sizes_by_id[item.product_size_id]
        is_bundle = size["products"]["is_bundle"]
        if is_bundle:
            continue
        _adjust_ingredients_for_size(
            supabase,
            item.product_size_id,
            item.quantity,
            sign=-1,
            employee_id=employee_id,
            transaction_id=transaction_id,
            held_ingredient_names=item.held_ingredients if held_ingredients_supported else None,
        )
        adjust_stock_items_for_product_unit(
            supabase, item.product_size_id, item.quantity, sign=-1,
            employee_id=employee_id, transaction_id=transaction_id,
        )
    # Once per transaction, not per item -- e.g. a takeout box consumed
    # once regardless of how many products are in the order.
    adjust_stock_items_for_transaction(
        supabase, order_type, guest_count, sign=-1,
        employee_id=employee_id, transaction_id=transaction_id,
    )

    if discount:
        discount_amount = subtotal * (discount["percentage"] / 100)
    discounted_subtotal = subtotal - discount_amount
    tax_amount = 0.0 if vat_exempt else discounted_subtotal * _get_vat_rate(supabase)

    updated = (
        supabase.table("transactions")
        .update(
            {
                "total_amount": discounted_subtotal,
                "discount_type_id": discount_type_id,
                "discount_amount": discount_amount,
                "tax_amount": tax_amount,
            }
        )
        .eq("id", transaction_id)
        .execute()
    )
    transaction = updated.data[0]
    transaction.setdefault("kitchen_status", "queued")
    transaction.setdefault("order_number", None)
    transaction.setdefault("order_type", None)
    transaction.setdefault("table_number", None)
    transaction.setdefault("guest_count", None)
    transaction.setdefault("payment_method", None)
    transaction.setdefault("card_type", None)
    transaction.setdefault("force_vat_exempt", False)
    return TransactionResponse(**transaction, items=inserted_items)


@router.post("/transactions", response_model=TransactionResponse)
def create_transaction(body: CreateTransactionRequest, user: CurrentUser = Depends(get_current_user)):
    """Create a sale via the POS. Auth/ownership and Owner's Request
    re-verification happen here; the actual insert/deduction/discount logic
    lives in _create_transaction_row, shared with digital-menu order
    approval."""
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot record a sale under another employee's id")
    if body.order_type == "dine_in" and not body.table_number:
        raise HTTPException(status_code=400, detail="Table number is required for dine-in orders")
    # Payment method is a hard requirement at the POS (unlike a discount) so the
    # till reconciles. The digital-order approval path doesn't come through here.
    if not body.payment_method:
        raise HTTPException(status_code=400, detail="Payment method is required")
    if body.payment_method == "card" and not body.card_type:
        raise HTTPException(status_code=400, detail="Select debit or credit")

    supabase = get_supabase()

    # WS-13: Business Day lock -- backend defense to match the frontend
    # overlay (POSTerminal.tsx), same belt-and-braces posture as the
    # kitchen-completed void guard. Executives are exempt -- the admin
    # account needs to be able to use POS regardless of whether a cashier
    # has started the day (e.g. testing, an ad-hoc sale, covering a shift).
    if user.role != "executive" and _business_days_supported_check(supabase):
        today_row = (
            supabase.table("business_days")
            .select("closed_at")
            .eq("business_date", today_ph().isoformat())
            .maybe_single()
            .execute()
        )
        if not today_row or not today_row.data or today_row.data["closed_at"] is not None:
            raise HTTPException(status_code=409, detail="Business day has not been started")

    # Owner's Request: the acting employee must re-verify their own kiosk
    # credentials (not just type a name) so this is a provable trace.
    owner_request_by = None
    if body.is_owner_request:
        if not body.owner_request_employee_number or not body.owner_request_pin:
            raise HTTPException(status_code=400, detail="Owner's Request requires employee number and PIN")
        profile = verify_employee_pin(body.owner_request_employee_number, body.owner_request_pin)
        if not profile or profile["id"] != user.id:
            raise HTTPException(status_code=403, detail="Employee ID/PIN did not match your logged-in account")
        owner_request_by = profile["id"]

    # Reservation block: a confirmed reservation holds its table in the POS
    # for [start - prep buffer, end). A manager can override, which mints a
    # single-use reservation_overrides row (see /pos/tables/override).
    consumed_override_id = None
    if body.order_type == "dine_in":
        blocked_table = _table_by_pos_number(supabase, body.table_number)
        if blocked_table and body.guest_count is not None:
            # Flexible-capacity floor-plan tables (0032): a party larger than
            # the table's max doesn't fit. Below the min is fine -- a small
            # party can sit at a bigger table.
            cap_max = blocked_table.get("capacity_max") or blocked_table["capacity"]
            if body.guest_count > cap_max:
                raise HTTPException(
                    status_code=400,
                    detail=f"Party of {body.guest_count} exceeds table {blocked_table['label']}'s capacity of {cap_max}",
                )
        blocking = _blocking_reservation(supabase, blocked_table["id"], _now_ph()) if blocked_table else None
        if blocking is not None:
            consumed_override_id = _validate_reservation_override(
                supabase, body.reservation_override_id, blocked_table["id"], blocking
            )

    result = _create_transaction_row(
        supabase,
        employee_id=body.employee_id,
        items=body.items,
        discount_type_id=body.discount_type_id,
        is_owner_request=body.is_owner_request,
        owner_request_by=owner_request_by,
        owner_request_note=body.owner_request_note,
        order_type=body.order_type,
        table_number=body.table_number,
        guest_count=body.guest_count,
        payment_method=body.payment_method,
        card_type=body.card_type,
        force_vat_exempt=body.force_vat_exempt,
    )

    if consumed_override_id is not None:
        supabase.table("reservation_overrides").update({"transaction_id": result.id}).eq(
            "id", consumed_override_id
        ).execute()

    # Seat-tracking: if this dine-in order is fulfilling a specific confirmed
    # reservation (Floor Plan "Seat this reservation" -> /pos?...&reservation=),
    # link the reservation to this transaction and stamp seated_at. A stale or
    # mismatched id is ignored -- it must never fail an otherwise-valid sale.
    if body.order_type == "dine_in" and body.reservation_id and blocked_table:
        reservation = (
            supabase.table("reservations")
            .select("id, status, table_id, reservation_date, seated_at")
            .eq("id", body.reservation_id)
            .maybe_single()
            .execute()
        )
        r = reservation.data if reservation and reservation.data else None
        if (
            r
            and r["status"] == "confirmed"
            and r["table_id"] == blocked_table["id"]
            and r["reservation_date"] == _now_ph().date().isoformat()
        ):
            patch = {"transaction_id": result.id}
            if not r.get("seated_at"):
                patch["seated_at"] = datetime.now(timezone.utc).isoformat()
            supabase.table("reservations").update(patch).eq("id", r["id"]).execute()

    return result


# Overrides must be redeemed promptly after a manager grants one -- long
# enough for the cashier to finish ringing up, short enough that a stale
# token can't be reused later in the shift.
_OVERRIDE_FRESHNESS_SECONDS = 600


def _validate_reservation_override(supabase, override_id, table_id, blocking_reservation) -> str:
    if not override_id:
        end = blocking_reservation["end_time"][:5]
        raise HTTPException(
            status_code=409,
            detail=f"Table is reserved for {blocking_reservation['customer_name']} until {end}. "
            "A manager override is required to seat here.",
        )

    row = (
        supabase.table("reservation_overrides")
        .select("id, table_id, reservation_id, transaction_id, created_at")
        .eq("id", override_id)
        .maybe_single()
        .execute()
    )
    override = row.data if row and row.data else None
    if not override or override["table_id"] != table_id or override["reservation_id"] != blocking_reservation["id"]:
        raise HTTPException(status_code=403, detail="Override does not match this table's current reservation")
    if override["transaction_id"] is not None:
        raise HTTPException(status_code=403, detail="Override has already been used")

    created = datetime.fromisoformat(override["created_at"])
    if (datetime.now(created.tzinfo) - created).total_seconds() > _OVERRIDE_FRESHNESS_SECONDS:
        raise HTTPException(status_code=403, detail="Override has expired -- ask a manager to override again")

    return override["id"]


@router.get("/transactions", response_model=list[TransactionResponse])
def list_transactions(
    on_date: date | None = Query(None, alias="date"),
    status_filter: str | None = Query(None, alias="status"),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    columns = (
        "id, employee_id, status, opened_at, closed_at, total_amount, discount_type_id, "
        "discount_amount, tax_amount, is_owner_request, owner_request_by, owner_request_note, "
        "voided_by, voided_at, void_reason, kitchen_status, kitchen_status_updated_at, "
        "order_type, table_number, guest_count, payment_method"
    )
    if _transaction_order_number_supported_check(supabase):
        columns += ", order_number"
    query = supabase.table("transactions").select(columns)
    if on_date:
        start, end = ph_day_bounds_utc(on_date)
        query = query.gte("opened_at", start).lte("opened_at", end)
    if status_filter:
        query = query.eq("status", status_filter)
    transactions_result = query.order("opened_at", desc=True).execute()
    transactions = transactions_result.data
    if not transactions:
        return []

    transaction_ids = [t["id"] for t in transactions]
    items_result = (
        supabase.table("transaction_items")
        .select("id, transaction_id, product_size_id, quantity, unit_price, held_ingredients")
        .in_("transaction_id", transaction_ids)
        .execute()
    )
    all_items = items_result.data
    fulfilled_ids = _bundle_fulfilled_item_ids(supabase, [i["id"] for i in all_items])
    _attach_item_addons(supabase, all_items)
    items_by_transaction: dict[str, list] = defaultdict(list)
    for item in all_items:
        item["bundle_fulfilled"] = item["id"] in fulfilled_ids
        items_by_transaction[item["transaction_id"]].append(item)

    out = []
    for t in transactions:
        t.setdefault("kitchen_status", "queued")
        t.setdefault("order_number", None)
        t.setdefault("order_type", None)
        t.setdefault("table_number", None)
        t.setdefault("guest_count", None)
        t.setdefault("payment_method", None)
        t.setdefault("card_type", None)
        t.setdefault("force_vat_exempt", False)
        out.append(TransactionResponse(**t, items=items_by_transaction.get(t["id"], [])))
    return out


@router.get("/transactions/{transaction_id}", response_model=TransactionResponse)
def get_transaction(transaction_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    items = transaction.pop("items")
    return TransactionResponse(**transaction, items=items)


@router.post("/transactions/{transaction_id}/close", response_model=TransactionResponse)
def close_transaction(transaction_id: str, user: CurrentUser = Depends(get_current_user)):
    """Settle an order and free its table -- the Floor Plan's "Diner done".
    The order was already paid when it was rung up at the POS, so this just
    moves it out of `open` (which is what the floor-plan occupancy logic keys
    on) and completes its kitchen ticket so it leaves the Kitchen Display."""
    supabase = get_supabase()
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if transaction["status"] != "open":
        raise HTTPException(status_code=409, detail=f"Order is already {transaction['status']}")

    now_iso = datetime.now(timezone.utc).isoformat()
    patch = {"status": "closed", "closed_at": now_iso}
    if _kitchen_status_supported_check(supabase) and transaction.get("kitchen_status") != "completed":
        patch["kitchen_status"] = "completed"
        patch["kitchen_status_updated_at"] = now_iso

    updated = supabase.table("transactions").update(patch).eq("id", transaction_id).execute()
    updated_row = updated.data[0]
    updated_row.setdefault("kitchen_status", "queued")
    updated_row.setdefault("order_type", None)
    updated_row.setdefault("table_number", None)
    updated_row.setdefault("guest_count", None)
    updated_row.setdefault("payment_method", None)
    updated_row.setdefault("card_type", None)
    updated_row.setdefault("force_vat_exempt", False)
    return TransactionResponse(**updated_row, items=transaction["items"])


@router.post("/transactions/{transaction_id}/switch-table", response_model=TransactionResponse)
def switch_table(transaction_id: str, body: SwitchTableRequest, user: CurrentUser = Depends(get_current_user)):
    """Floor Plan's "Switch table / transfer" action on an occupied table --
    moves an open dine-in order (and its linked seated reservation, if any)
    to a different table number. Unrelated to void's queued-only gate;
    this only ever touches an order that's still open."""
    supabase = get_supabase()
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if transaction["status"] != "open":
        raise HTTPException(status_code=409, detail=f"Order is already {transaction['status']}")
    if transaction.get("order_type") != "dine_in" or not transaction.get("table_number"):
        raise HTTPException(status_code=400, detail="Only a seated dine-in order can switch tables")
    if body.new_table_number == transaction["table_number"]:
        raise HTTPException(status_code=400, detail="Already seated at that table")

    new_table = _table_by_pos_number(supabase, body.new_table_number)
    if not new_table or not new_table.get("active", True):
        raise HTTPException(status_code=404, detail="No active reservation table is mapped to that POS number")

    guest_count = transaction.get("guest_count")
    cap_max = new_table.get("capacity_max") or new_table["capacity"]
    if guest_count is not None and guest_count > cap_max:
        raise HTTPException(
            status_code=400,
            detail=f"Party of {guest_count} exceeds table {new_table['label']}'s capacity of {cap_max}",
        )

    other_open = (
        supabase.table("transactions")
        .select("id")
        .eq("table_number", body.new_table_number)
        .eq("status", "open")
        .neq("id", transaction_id)
        .execute()
    )
    if other_open.data:
        raise HTTPException(status_code=409, detail=f"Table {body.new_table_number} is already occupied")

    blocking = _blocking_reservation(supabase, new_table["id"], _now_ph())
    if blocking:
        raise HTTPException(
            status_code=409,
            detail=f"Table {body.new_table_number} is reserved for {blocking['customer_name']} until {blocking['end_time']}",
        )

    updated = (
        supabase.table("transactions")
        .update({"table_number": body.new_table_number})
        .eq("id", transaction_id)
        .execute()
    )
    updated_row = updated.data[0]
    updated_row.setdefault("kitchen_status", "queued")
    updated_row.setdefault("order_type", None)
    updated_row.setdefault("table_number", None)
    updated_row.setdefault("guest_count", None)
    updated_row.setdefault("payment_method", None)
    updated_row.setdefault("card_type", None)
    updated_row.setdefault("force_vat_exempt", False)

    # Keep a linked, still-seated reservation's own table assignment in sync
    # so the Floor Plan doesn't also show it blocking the vacated table.
    linked_reservation = (
        supabase.table("reservations")
        .select("id")
        .eq("transaction_id", transaction_id)
        .maybe_single()
        .execute()
    )
    if linked_reservation and linked_reservation.data:
        supabase.table("reservations").update({"table_id": new_table["id"]}).eq(
            "id", linked_reservation.data["id"]
        ).execute()

    return TransactionResponse(**updated_row, items=transaction["items"])


def void_transaction_core(supabase, transaction: dict, actor_id: str, reason: str) -> tuple[dict, list[dict]]:
    """Shared restore-and-mark-voided logic, used by both the direct void
    endpoint (queued-only, see its own gate below) and refund approval
    (transactions.py's own queued-only gate is specifically a limit on the
    cashier's *self-service* void -- an admin/executive who already
    approved a refund request is authorized to void regardless of the
    order's current kitchen_status, e.g. if it advanced to preparing while
    the request sat pending review).

    For a bundle line item that was already kitchen-fulfilled (has
    bundle_fulfillments rows), restores each fulfilled roll's own BOM
    (not a blind full-recipe restore, since bundles have no recipe of their
    own) and clears those fulfillment rows. A bundle item never fulfilled
    has nothing to restore.

    Add-ons (0026) need no restore step here -- like menu_addons generally,
    they carry no recipe_items/stock impact, so there's nothing to give
    back. transaction_item_addons rows are left in place (cascade-deleted
    only if the item itself is ever deleted, which void never does).

    Returns (updated_row, response_items) -- the caller wraps these into
    whatever response shape it needs.
    """
    transaction_id = transaction["id"]
    size_ids = [row["product_size_id"] for row in transaction["items"]]
    sizes_result = (
        supabase.table("product_sizes").select("id, products(is_bundle)").in_("id", size_ids).execute()
        if size_ids
        else None
    )
    is_bundle_by_size = {s["id"]: s["products"]["is_bundle"] for s in (sizes_result.data if sizes_result else [])}

    bundle_supported = _bundle_fulfillments_supported_check(supabase)

    for row in transaction["items"]:
        if is_bundle_by_size.get(row["product_size_id"]):
            if not bundle_supported:
                continue
            fulfillments = (
                supabase.table("bundle_fulfillments")
                .select("*")
                .eq("transaction_item_id", row["id"])
                .execute()
            )
            for f in fulfillments.data:
                roll_size_result = (
                    supabase.table("product_sizes")
                    .select("id")
                    .eq("product_id", f["maki_roll_product_id"])
                    .execute()
                )
                for roll_size in roll_size_result.data:
                    _adjust_ingredients_for_size(
                        supabase, roll_size["id"], f["quantity"], sign=1,
                        employee_id=actor_id, transaction_id=transaction_id,
                    )
            if fulfillments.data:
                supabase.table("bundle_fulfillments").delete().eq("transaction_item_id", row["id"]).execute()
        else:
            _adjust_ingredients_for_size(
                supabase,
                row["product_size_id"],
                float(row["quantity"]),
                sign=1,
                employee_id=actor_id,
                transaction_id=transaction_id,
                held_ingredient_names=row.get("held_ingredients"),
            )
            adjust_stock_items_for_product_unit(
                supabase, row["product_size_id"], float(row["quantity"]), sign=1,
                employee_id=actor_id, transaction_id=transaction_id,
            )
    adjust_stock_items_for_transaction(
        supabase, transaction.get("order_type"), transaction.get("guest_count"), sign=1,
        employee_id=actor_id, transaction_id=transaction_id,
    )

    updated = (
        supabase.table("transactions")
        .update(
            {
                "status": "voided",
                "voided_by": actor_id,
                "voided_at": datetime.now(timezone.utc).isoformat(),
                "void_reason": reason,
            }
        )
        .eq("id", transaction_id)
        .execute()
    )
    updated_row = updated.data[0]
    updated_row.setdefault("kitchen_status", "queued")
    updated_row.setdefault("order_type", None)
    updated_row.setdefault("table_number", None)
    updated_row.setdefault("guest_count", None)
    updated_row.setdefault("payment_method", None)
    updated_row.setdefault("card_type", None)
    updated_row.setdefault("force_vat_exempt", False)

    # transaction["items"] was fetched (with its bundle_fulfilled flags)
    # before the restore loop above deleted this transaction's
    # bundle_fulfillments rows -- recompute so the response reflects what's
    # actually true right now, not a pre-restore snapshot.
    response_items = transaction["items"]
    fulfilled_ids = _bundle_fulfilled_item_ids(supabase, [i["id"] for i in response_items])
    for item in response_items:
        item["bundle_fulfilled"] = item["id"] in fulfilled_ids

    return updated_row, response_items


@router.post("/transactions/{transaction_id}/void", response_model=TransactionResponse)
def void_transaction(
    transaction_id: str,
    body: VoidTransactionRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Cashier/manager self-service void -- WS-12 narrows this to `queued`
    orders only; anything past that (preparing/ready/completed) must go
    through a Refund request instead (see refunds.py), which an
    admin/executive approves via void_transaction_core directly."""
    supabase = get_supabase()

    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if user.role == "employee" and transaction["employee_id"] != user.id:
        raise HTTPException(status_code=403, detail="Employees may only void their own orders")
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="Transaction is already voided")
    if _kitchen_status_supported_check(supabase) and transaction.get("kitchen_status") != "queued":
        raise HTTPException(status_code=409, detail="Only a queued order can be voided directly -- use a Refund request instead")

    updated_row, response_items = void_transaction_core(supabase, transaction, user.id, body.reason)
    return TransactionResponse(**updated_row, items=response_items)


def _set_kitchen_status(supabase, transaction: dict, new_status: str, user: CurrentUser, allow_skip: bool) -> dict:
    if user.role == "employee" and transaction["employee_id"] != user.id:
        raise HTTPException(status_code=403, detail="Employees may only update their own orders")
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="Cannot update a voided order")

    current = transaction.get("kitchen_status", "queued")
    if new_status == current:
        raise HTTPException(status_code=400, detail=f"Order is already {new_status}")

    if not allow_skip:
        current_index = KITCHEN_STATUS_ORDER.index(current)
        new_index = KITCHEN_STATUS_ORDER.index(new_status)
        if new_index != current_index + 1:
            raise HTTPException(status_code=400, detail=f"Cannot move directly from {current} to {new_status}")

    updated = (
        supabase.table("transactions")
        .update({"kitchen_status": new_status, "kitchen_status_updated_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", transaction["id"])
        .execute()
    )
    return updated.data[0]


@router.patch("/transactions/{transaction_id}/kitchen-status", response_model=TransactionResponse)
def update_kitchen_status(
    transaction_id: str,
    body: KitchenStatusUpdateRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Strict single forward step only (queued->preparing->ready->completed);
    400 on an invalid jump. See /fulfill for the "jump straight to completed"
    variant."""
    supabase = get_supabase()
    if not _kitchen_status_supported_check(supabase):
        raise HTTPException(status_code=501, detail=_MIGRATION_PENDING_DETAIL)

    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")

    updated = _set_kitchen_status(supabase, transaction, body.kitchen_status, user, allow_skip=False)
    updated.setdefault("kitchen_status", "queued")
    updated.setdefault("order_type", None)
    updated.setdefault("table_number", None)
    updated.setdefault("guest_count", None)
    updated.setdefault("payment_method", None)
    updated.setdefault("card_type", None)
    updated.setdefault("force_vat_exempt", False)
    return TransactionResponse(**updated, items=transaction["items"])


@router.post("/transactions/{transaction_id}/fulfill", response_model=TransactionResponse)
def fulfill_transaction(transaction_id: str, user: CurrentUser = Depends(get_current_user)):
    """Marks an order done -- allowed to skip queued/preparing/ready directly
    to completed, since front-of-house may close an order without the
    kitchen ever tracking it through Kitchen Display."""
    supabase = get_supabase()
    if not _kitchen_status_supported_check(supabase):
        raise HTTPException(status_code=501, detail=_MIGRATION_PENDING_DETAIL)

    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")

    updated = _set_kitchen_status(supabase, transaction, "completed", user, allow_skip=True)
    updated.setdefault("kitchen_status", "queued")
    updated.setdefault("order_type", None)
    updated.setdefault("table_number", None)
    updated.setdefault("guest_count", None)
    updated.setdefault("payment_method", None)
    updated.setdefault("card_type", None)
    updated.setdefault("force_vat_exempt", False)
    return TransactionResponse(**updated, items=transaction["items"])


@router.post(
    "/transactions/{transaction_id}/items/{item_id}/bundle-fulfillment",
    response_model=BundleFulfillmentResponse,
)
def bundle_fulfillment(
    transaction_id: str,
    item_id: str,
    body: BundleFulfillmentRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Kitchen logs which actual Oishii Maki Rolls (and how many of each)
    went into a specific bundle line item (Platter / Sushi Boat), replacing
    proportional auto-deduction for that item. The submitted line quantities
    must sum to exactly bundle_components.total_pieces * the item's ordered
    quantity; each roll's own product_size/recipe_items BOM is then deducted
    the same way a direct sale of that many rolls would be.
    """
    supabase = get_supabase()
    if not _bundle_fulfillments_supported_check(supabase):
        raise HTTPException(status_code=501, detail=_MIGRATION_PENDING_DETAIL)
    if not body.lines:
        raise HTTPException(status_code=400, detail="At least one roll line is required")

    item_result = (
        supabase.table("transaction_items")
        .select("*, product_sizes(id, product_id, products(is_bundle))")
        .eq("id", item_id)
        .maybe_single()
        .execute()
    )
    if not item_result or not item_result.data or item_result.data["transaction_id"] != transaction_id:
        raise HTTPException(status_code=404, detail="Order item not found on this transaction")
    item = item_result.data
    size = item["product_sizes"]
    if not size["products"]["is_bundle"]:
        raise HTTPException(status_code=400, detail="This order item is not a bundle product")

    bundle_result = (
        supabase.table("bundle_components")
        .select("total_pieces")
        .eq("product_size_id", size["id"])
        .maybe_single()
        .execute()
    )
    if not bundle_result or not bundle_result.data:
        raise HTTPException(status_code=404, detail="No bundle configuration found for this product size")
    total_pieces = bundle_result.data["total_pieces"]
    required_total = round(total_pieces * float(item["quantity"]))

    submitted_total = sum(line.quantity for line in body.lines)
    if submitted_total != required_total:
        raise HTTPException(
            status_code=400,
            detail=f"Submitted roll quantities sum to {submitted_total}, expected {required_total} "
            f"({total_pieces} pieces x {item['quantity']} ordered)",
        )

    existing = (
        supabase.table("bundle_fulfillments").select("id").eq("transaction_item_id", item_id).execute()
    )
    if existing.data:
        raise HTTPException(status_code=400, detail="This bundle item has already been fulfilled")

    roll_product_ids = [line.maki_roll_product_id for line in body.lines]
    rolls_result = (
        supabase.table("products").select("id, name, is_bundle").in_("id", roll_product_ids).execute()
    )
    rolls_by_id = {r["id"]: r for r in rolls_result.data}
    missing_rolls = [pid for pid in roll_product_ids if pid not in rolls_by_id]
    if missing_rolls:
        raise HTTPException(status_code=404, detail=f"Products not found: {missing_rolls}")
    bundle_rolls = [pid for pid in roll_product_ids if rolls_by_id[pid]["is_bundle"]]
    if bundle_rolls:
        raise HTTPException(status_code=400, detail="A bundle-fulfillment line cannot itself be a bundle product")

    ingredient_totals: dict[str, float] = defaultdict(float)
    ingredient_names: dict[str, str] = {}
    ingredient_units: dict[str, str] = {}

    for line in body.lines:
        roll_sizes = (
            supabase.table("product_sizes").select("id").eq("product_id", line.maki_roll_product_id).execute()
        )
        if len(roll_sizes.data) != 1:
            raise HTTPException(
                status_code=400,
                detail=f"Product {line.maki_roll_product_id} does not resolve to exactly one size "
                f"(found {len(roll_sizes.data)}) -- cannot deduct an unambiguous BOM for it",
            )
        roll_size_id = roll_sizes.data[0]["id"]

        recipe_result = (
            supabase.table("recipe_items")
            .select("ingredient_id, qty_per_serving, unit, ingredients(name)")
            .eq("product_size_id", roll_size_id)
            .execute()
        )
        for recipe_item in recipe_result.data:
            ingredient_id = recipe_item["ingredient_id"]
            ingredient_names[ingredient_id] = recipe_item["ingredients"]["name"]
            ingredient_units[ingredient_id] = recipe_item["unit"]
            ingredient_totals[ingredient_id] += float(recipe_item["qty_per_serving"]) * line.quantity

        _adjust_ingredients_for_size(
            supabase, roll_size_id, line.quantity, sign=-1,
            employee_id=user.id, transaction_id=transaction_id,
        )

        supabase.table("bundle_fulfillments").insert(
            {
                "transaction_item_id": item_id,
                "maki_roll_product_id": line.maki_roll_product_id,
                "quantity": line.quantity,
                "fulfilled_by": user.id,
            }
        ).execute()

    return BundleFulfillmentResponse(
        transaction_item_id=item_id,
        total_pieces=required_total,
        lines=body.lines,
        ingredients_deducted=[
            DeductedIngredient(
                ingredient_id=iid,
                ingredient_name=ingredient_names[iid],
                quantity=qty,
                unit=ingredient_units[iid],
            )
            for iid, qty in ingredient_totals.items()
        ],
    )
