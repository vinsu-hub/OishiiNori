from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role, verify_employee_pin
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc
from app.schemas import (
    BundleFulfillmentRequest,
    BundleFulfillmentResponse,
    CreateTransactionRequest,
    DeductedIngredient,
    KitchenStatusUpdateRequest,
    TransactionResponse,
    VoidTransactionRequest,
)

router = APIRouter(tags=["transactions"])

# JUDGMENT CALL: not specified by the task. 12% is the standard Philippine
# VAT rate and matches the SMFC reference's VAT_RATE constant.
VAT_RATE = 0.12

KITCHEN_STATUS_ORDER = ["queued", "preparing", "ready", "completed"]

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


_MIGRATION_PENDING_DETAIL = (
    "This feature requires supabase/migrations/0014_phase2_order_fulfillment.sql "
    "to be applied to the live database. It has not been applied yet (blocked at "
    "build time by a tool permission gate on running DDL against the live DB -- "
    "see the Phase 2 backend handoff report). Apply the migration, then this "
    "endpoint will work without any code changes."
)


def _adjust_ingredients_for_size(supabase, product_size_id: str, quantity: float, sign: int) -> dict[str, float]:
    """Applies recipe-based stock changes for one product_size sold/restored.
    sign=-1 deducts (a sale), sign=1 restores (a void). Returns the ingredient
    deltas actually applied (id -> signed delta), for logging/response use.

    qty_per_serving is used LITERALLY, per task spec -- it is already
    pre-scaled per size tier in the seed data; scale_factor on product_sizes
    is documentation-only and must not be applied again here.
    """
    recipe_result = (
        supabase.table("recipe_items")
        .select("ingredient_id, qty_per_serving")
        .eq("product_size_id", product_size_id)
        .execute()
    )
    deltas: dict[str, float] = {}
    for recipe_item in recipe_result.data:
        ingredient_id = recipe_item["ingredient_id"]
        delta_qty = float(recipe_item["qty_per_serving"]) * quantity * sign

        ingredient_result = (
            supabase.table("ingredients").select("current_stock").eq("id", ingredient_id).single().execute()
        )
        current_stock = float(ingredient_result.data["current_stock"])
        new_stock = current_stock + delta_qty
        supabase.table("ingredients").update({"current_stock": new_stock}).eq("id", ingredient_id).execute()
        deltas[ingredient_id] = delta_qty
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
    result = (
        supabase.table("bundle_fulfillments")
        .select("transaction_item_id")
        .in_("transaction_item_id", item_ids)
        .execute()
    )
    return {row["transaction_item_id"] for row in result.data}


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
    transaction["items"] = items
    transaction.setdefault("kitchen_status", "queued")
    return transaction


def _create_transaction_row(
    supabase,
    employee_id: str,
    items: list,
    discount_type_id: str | None = None,
    is_owner_request: bool = False,
    owner_request_by: str | None = None,
    owner_request_note: str | None = None,
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
        vat_exempt = discount["vat_exempt"]

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

    transaction_insert = supabase.table("transactions").insert(insert_payload).execute()
    transaction = transaction_insert.data[0]
    transaction_id = transaction["id"]

    held_ingredients_supported = _held_ingredients_supported_check(supabase)

    subtotal = 0.0
    item_rows = []
    for item in items:
        size = sizes_by_id[item.product_size_id]
        unit_price = float(size["price"])
        subtotal += unit_price * item.quantity
        row = {
            "transaction_id": transaction_id,
            "product_size_id": item.product_size_id,
            "quantity": item.quantity,
            "unit_price": unit_price,
        }
        if held_ingredients_supported:
            row["held_ingredients"] = item.held_ingredients
        item_rows.append(row)

    items_insert = supabase.table("transaction_items").insert(item_rows).execute()

    for item in items:
        size = sizes_by_id[item.product_size_id]
        is_bundle = size["products"]["is_bundle"]
        if is_bundle:
            continue
        _adjust_ingredients_for_size(supabase, item.product_size_id, item.quantity, sign=-1)

    if discount:
        discount_amount = subtotal * (discount["percentage"] / 100)
    discounted_subtotal = subtotal - discount_amount
    tax_amount = 0.0 if vat_exempt else discounted_subtotal * VAT_RATE

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
    return TransactionResponse(**transaction, items=items_insert.data)


@router.post("/transactions", response_model=TransactionResponse)
def create_transaction(body: CreateTransactionRequest, user: CurrentUser = Depends(get_current_user)):
    """Create a sale via the POS. Auth/ownership and Owner's Request
    re-verification happen here; the actual insert/deduction/discount logic
    lives in _create_transaction_row, shared with digital-menu order
    approval."""
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot record a sale under another employee's id")

    supabase = get_supabase()

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

    return _create_transaction_row(
        supabase,
        employee_id=body.employee_id,
        items=body.items,
        discount_type_id=body.discount_type_id,
        is_owner_request=body.is_owner_request,
        owner_request_by=owner_request_by,
        owner_request_note=body.owner_request_note,
    )


@router.get("/transactions", response_model=list[TransactionResponse])
def list_transactions(
    on_date: date | None = Query(None, alias="date"),
    status_filter: str | None = Query(None, alias="status"),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("transactions").select("*")
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
        supabase.table("transaction_items").select("*").in_("transaction_id", transaction_ids).execute()
    )
    all_items = items_result.data
    fulfilled_ids = _bundle_fulfilled_item_ids(supabase, [i["id"] for i in all_items])
    items_by_transaction: dict[str, list] = defaultdict(list)
    for item in all_items:
        item["bundle_fulfilled"] = item["id"] in fulfilled_ids
        items_by_transaction[item["transaction_id"]].append(item)

    out = []
    for t in transactions:
        t.setdefault("kitchen_status", "queued")
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
    supabase = get_supabase()
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")

    updated = (
        supabase.table("transactions")
        .update({"status": "closed", "closed_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", transaction_id)
        .execute()
    )
    updated_row = updated.data[0]
    updated_row.setdefault("kitchen_status", "queued")
    return TransactionResponse(**updated_row, items=transaction["items"])


@router.post("/transactions/{transaction_id}/void", response_model=TransactionResponse)
def void_transaction(
    transaction_id: str,
    body: VoidTransactionRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Voids an order and restores the inventory it actually consumed.
    Employees may only void their own orders; manager/executive may void any.

    For a bundle line item that was already kitchen-fulfilled (has
    bundle_fulfillments rows), restores each fulfilled roll's own BOM
    (not a blind full-recipe restore, since bundles have no recipe of their
    own) and clears those fulfillment rows. A bundle item never fulfilled
    has nothing to restore.
    """
    supabase = get_supabase()

    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if user.role == "employee" and transaction["employee_id"] != user.id:
        raise HTTPException(status_code=403, detail="Employees may only void their own orders")
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="Transaction is already voided")

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
                    _adjust_ingredients_for_size(supabase, roll_size["id"], f["quantity"], sign=1)
            if fulfillments.data:
                supabase.table("bundle_fulfillments").delete().eq("transaction_item_id", row["id"]).execute()
        else:
            _adjust_ingredients_for_size(supabase, row["product_size_id"], float(row["quantity"]), sign=1)

    updated = (
        supabase.table("transactions")
        .update(
            {
                "status": "voided",
                "voided_by": user.id,
                "voided_at": datetime.now(timezone.utc).isoformat(),
                "void_reason": body.reason,
            }
        )
        .eq("id", transaction_id)
        .execute()
    )
    updated_row = updated.data[0]
    updated_row.setdefault("kitchen_status", "queued")
    return TransactionResponse(**updated_row, items=transaction["items"])


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

        _adjust_ingredients_for_size(supabase, roll_size_id, line.quantity, sign=-1)

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
