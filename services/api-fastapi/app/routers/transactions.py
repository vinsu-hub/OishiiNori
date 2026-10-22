import logging
import re
import threading
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from cachetools import TTLCache
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field, TypeAdapter

from app.auth import CurrentUser, get_current_user, require_role, verify_employee_pin, verify_override_key
from app.bundles import atomic_bundles_available, bundle_rpc, completed_bundle_ids, legacy_recipe_sizes, pending_bundle_item_ids
from app.deps import get_supabase
from app.idempotency import check_idempotency_key, record_idempotency_key
from app.ph_time import ph_day_bounds_utc, today_ph
from app.routers.reservations import _blocking_reservation, _now_ph, _table_by_pos_number
from app.routers.sales_insights import _page_rows, ID_BATCH_SIZE
from app.routers.stock_items import adjust_stock_items_for_product_unit, adjust_stock_items_for_transaction
from app.schemas import (
    BundleFulfillmentRequest,
    BundleFulfillmentResponse,
    CreateTransactionRequest,
    DeliveryCaptureIn,
    KitchenStatus,
    KitchenStatusUpdateRequest,
    RiderPayoutUpdate,
    PosHangedOrderCreate,
    RescheduleAdvanceOrderRequest,
    TransactionItemCreate,
    UpdateAdvanceItemsRequest,
    SettlePaymentRequest,
    TransactionCardType,
    TransactionPaymentMethod,
    SwitchTableRequest,
    TransactionResponse,
    VoidTransactionRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["transactions"])


FRONT_OF_HOUSE_ROLES = ("employee", "manager", "executive")


@router.get("/pos/hanged-orders")
def list_pos_hanged_orders(user: CurrentUser = Depends(get_current_user)):
    # Shared across the front counter: any cashier can pick up another
    # cashier's hanged order (shift handover, the rider coming back later).
    if user.role not in FRONT_OF_HOUSE_ROLES:
        raise HTTPException(status_code=403, detail="Only front-of-house staff can manage hanged orders")
    supabase = get_supabase()
    result = supabase.table("pos_hanged_orders").select("*").in_("status", ["draft", "processing"]).order("created_at", desc=True).execute()
    rows = result.data or []
    # Sent orders stay on the tab until they are completed and paid, then
    # remain listed for the rest of the PH day as a reference.
    since = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    submitted = (supabase.table("pos_hanged_orders").select("*").eq("status", "submitted")
                 .gte("updated_at", since).order("created_at", desc=True).execute().data or [])
    for row in rows:
        row["transaction"] = None
    rows.extend(_attach_hanged_transactions(supabase, submitted))
    return rows


def _attach_hanged_transactions(supabase, rows: list[dict]) -> list[dict]:
    """Attaches each submitted hanged order's sale as row['transaction'],
    keeping unfinished ones plus those completed today."""
    transaction_ids = [row["transaction_id"] for row in rows if row.get("transaction_id")]
    if not transaction_ids:
        return []
    transactions = supabase.table("transactions").select("*").in_("id", transaction_ids).execute().data or []
    _attach_deliveries(supabase, transactions)
    by_id = {t["id"]: t for t in transactions}
    today_start = datetime.fromisoformat(ph_day_bounds_utc(today_ph())[0])
    kept = []
    for row in rows:
        transaction = by_id.get(row.get("transaction_id"))
        if not transaction or transaction["status"] == "voided":
            continue
        unfinished = transaction["status"] == "open" or transaction.get("payment_status") == "unpaid"
        closed_today = bool(transaction.get("closed_at")) and datetime.fromisoformat(transaction["closed_at"].replace("Z", "+00:00")) >= today_start
        if unfinished or closed_today:
            row["transaction"] = transaction
            kept.append(row)
    return kept


@router.post("/pos/hanged-orders")
def create_pos_hanged_order(body: PosHangedOrderCreate, user: CurrentUser = Depends(get_current_user)):
    if user.role == "kitchen":
        raise HTTPException(status_code=403, detail="Kitchen accounts cannot manage cashier orders")
    payload = body.payload
    if payload.employee_id != user.id or payload.order_type != "delivery":
        raise HTTPException(status_code=400, detail="Hanged orders must be delivery orders created by the signed-in cashier")
    if not payload.items or not payload.delivery:
        raise HTTPException(status_code=400, detail="Items and delivery details are required")
    result = get_supabase().table("pos_hanged_orders").insert({"employee_id": user.id, "payload": payload.model_dump(mode="json"), "status": "draft"}).execute()
    return result.data[0]


@router.patch("/pos/hanged-orders/{order_id}")
def update_pos_hanged_order(order_id: str, body: PosHangedOrderCreate, user: CurrentUser = Depends(get_current_user)):
    if user.role not in FRONT_OF_HOUSE_ROLES:
        raise HTTPException(status_code=403, detail="Only front-of-house staff can manage hanged orders")
    payload = body.payload
    if payload.order_type != "delivery" or not payload.items or not payload.delivery:
        raise HTTPException(status_code=400, detail="A valid delivery order is required")
    result = get_supabase().table("pos_hanged_orders").update({"payload": payload.model_dump(mode="json"), "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", order_id).eq("status", "draft").execute()
    if not result.data:
        raise HTTPException(status_code=409, detail="Draft not found or already sent to the kitchen")
    return result.data[0]


@router.post("/pos/hanged-orders/{order_id}/send-to-kitchen")
def submit_pos_hanged_order(order_id: str, user: CurrentUser = Depends(get_current_user)):
    if user.role not in FRONT_OF_HOUSE_ROLES:
        raise HTTPException(status_code=403, detail="Only front-of-house staff can charge sales")
    supabase = get_supabase()
    found = supabase.table("pos_hanged_orders").select("*").eq("id", order_id).maybe_single().execute()
    if not found or not found.data:
        raise HTTPException(status_code=404, detail="Hanged order not found")
    row = found.data
    if row["status"] == "submitted" and row.get("transaction_id"):
        return get_transaction(row["transaction_id"], user)
    claimed = supabase.table("pos_hanged_orders").update({"status": "processing", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", order_id).eq("status", "draft").execute()
    if not claimed.data:
        # Recover a worker/process interruption after two minutes. The stable
        # idempotency key below ensures a retry cannot create a second sale.
        stale_before = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        supabase.table("pos_hanged_orders").update({"status": "draft"}).eq("id", order_id).eq("status", "processing").lt("updated_at", stale_before).execute()
        claimed = supabase.table("pos_hanged_orders").update({"status": "processing", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", order_id).eq("status", "draft").execute()
    if not claimed.data:
        raise HTTPException(status_code=409, detail="This order is already being sent to the kitchen")
    payload = CreateTransactionRequest(**row["payload"])
    payload.employee_id = user.id
    payload.order_type = "delivery"
    payload.order_source = "pos"
    payload.payment_method = "cash"
    payload.pay_on_delivery = True
    # Stable per draft (the idempotency column is a uuid), so a retried send
    # returns the first sale instead of creating a second one.
    payload.idempotency_key = str(uuid.uuid5(uuid.NAMESPACE_URL, f"hanged-order:{order_id}"))
    try:
        transaction = create_transaction(payload, user)
        supabase.table("pos_hanged_orders").update({"status": "submitted", "transaction_id": transaction.id, "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", order_id).execute()
        return transaction
    except Exception:
        supabase.table("pos_hanged_orders").update({"status": "draft", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", order_id).eq("status", "processing").execute()
        raise


@router.post("/pos/hanged-orders/{order_id}/complete")
def complete_pos_hanged_order(order_id: str, body: SettlePaymentRequest, user: CurrentUser = Depends(get_current_user)):
    """Punches a sent hanged order as done: records the payment, marks the
    delivery delivered, and closes the sale. Steps already done are skipped."""
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="Only front-of-house staff can receive payments")
    supabase = get_supabase()
    found = supabase.table("pos_hanged_orders").select("*").eq("id", order_id).maybe_single().execute()
    if not found or not found.data:
        raise HTTPException(status_code=404, detail="Hanged order not found")
    row = found.data
    if row["status"] != "submitted" or not row.get("transaction_id"):
        raise HTTPException(status_code=409, detail="Send this order to the kitchen before completing it")
    transaction_id = row["transaction_id"]
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="This order was voided")
    if transaction.get("payment_status") == "unpaid":
        settle_payment(transaction_id, body, user)
    if _deliveries_transaction_id_supported_check(supabase):
        supabase.table("deliveries").update({"delivered_at": datetime.now(timezone.utc).isoformat()}).eq(
            "transaction_id", transaction_id).is_("delivered_at", "null").execute()
    if transaction["status"] == "open":
        close_transaction(transaction_id, user)
    kept = _attach_hanged_transactions(supabase, [row])
    if kept:
        return kept[0]
    row["transaction"] = None
    return row


KITCHEN_STATUS_ORDER = ["queued", "preparing", "ready", "completed"]


def _single_discount_item_index(items: list, order_discount_type_id: str | None) -> int | None:
    indexes = [index for index, item in enumerate(items) if item.discount_type_id]
    if len(indexes) > 1:
        raise HTTPException(status_code=400, detail="Only one item can receive a discount")
    if indexes and order_discount_type_id:
        raise HTTPException(status_code=400, detail="Cannot combine item and order discounts")
    index = indexes[0] if indexes else None
    if index is not None and items[index].quantity < 1:
        raise HTTPException(status_code=400, detail="A discounted item needs at least one unit")
    return index


def _one_unit_discount(price: float, percentage: float) -> float:
    return float((Decimal(str(price)) * Decimal(str(percentage)) / Decimal("100"))
                 .quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


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
_transaction_order_source_supported: bool | None = None
_transaction_order_number_supported: bool | None = None
_business_days_supported: bool | None = None
_transaction_card_vat_supported: bool | None = None
_deliveries_transaction_id_supported: bool | None = None
_payment_status_supported: bool | None = None
_advance_supported: bool | None = None
_kitchen_reprint_supported: bool | None = None
_item_discounts_supported: bool | None = None
ADVANCE_LEAD = timedelta(minutes=20)


def _item_discounts_supported_check(supabase) -> bool:
    global _item_discounts_supported
    if _item_discounts_supported is None:
        try:
            supabase.table("transaction_items").select("discount_amount,discount_vat_exempt").limit(1).execute()
            _item_discounts_supported = True
        except APIError:
            _item_discounts_supported = False
    return _item_discounts_supported


def _advance_supported_check(supabase) -> bool:
    global _advance_supported
    if _advance_supported is None:
        try:
            supabase.table("transactions").select("scheduled_for,advance_schedule_revision").limit(1).execute()
            _advance_supported = True
        except APIError:
            _advance_supported = False
    return _advance_supported


_kitchen_reprint_checked_at = 0.0


def _kitchen_reprint_supported_check(supabase) -> bool:
    """Once the column is there it stays there; "missing" is re-checked every
    minute, so a server that started before 0081 was run picks it up."""
    global _kitchen_reprint_supported, _kitchen_reprint_checked_at
    if _kitchen_reprint_supported or time.monotonic() - _kitchen_reprint_checked_at < 60:
        return bool(_kitchen_reprint_supported)
    _kitchen_reprint_checked_at = time.monotonic()
    try:
        supabase.table("transactions").select("kitchen_reprint_requested_at").limit(1).execute()
        _kitchen_reprint_supported = True
    except APIError:
        _kitchen_reprint_supported = False
    return _kitchen_reprint_supported


def _validate_advance_time(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise HTTPException(status_code=400, detail="Advance time must include a timezone")
    now = datetime.now(timezone.utc)
    utc_value = value.astimezone(timezone.utc)
    if utc_value < now + timedelta(minutes=30) or utc_value > now + timedelta(days=7):
        raise HTTPException(status_code=400, detail="Advance time must be 30 minutes to 7 days ahead")
    return utc_value


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


def _transaction_order_source_supported_check(supabase) -> bool:
    global _transaction_order_source_supported
    if _transaction_order_source_supported is None:
        try:
            supabase.table("transactions").select("order_source").limit(1).execute()
            _transaction_order_source_supported = True
        except APIError:
            _transaction_order_source_supported = False
    return _transaction_order_source_supported


def _payment_status_supported_check(supabase) -> bool:
    """Migration 0062 feature-detection (pay on delivery), same pattern."""
    global _payment_status_supported
    if _payment_status_supported is None:
        try:
            supabase.table("transactions").select("payment_status, paid_at").limit(1).execute()
            _payment_status_supported = True
        except APIError:
            _payment_status_supported = False
    return _payment_status_supported


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


def _deliveries_transaction_id_supported_check(supabase) -> bool:
    """Migration 0051 feature-detection, same pattern as the checks above --
    deliveries.transaction_id (POS-originated delivery orders)."""
    global _deliveries_transaction_id_supported
    if _deliveries_transaction_id_supported is None:
        try:
            supabase.table("deliveries").select("transaction_id").limit(1).execute()
            _deliveries_transaction_id_supported = True
        except APIError:
            _deliveries_transaction_id_supported = False
    return _deliveries_transaction_id_supported


def _attach_deliveries(supabase, transactions: list[dict]) -> None:
    """Batch-fetches the deliveries row for delivery-order-type transactions
    and attaches it as t['delivery'] -- mirrors _attach_item_addons. No-ops
    (leaves delivery: None) when migration 0051 hasn't been applied yet."""
    for t in transactions:
        t.setdefault("delivery", None)
    delivery_tx_ids = [t["id"] for t in transactions if t.get("order_type") == "delivery"]
    if not delivery_tx_ids or not _deliveries_transaction_id_supported_check(supabase):
        return
    delivery_rows: list[dict] = []
    for offset in range(0, len(delivery_tx_ids), ID_BATCH_SIZE):
        delivery_rows.extend(
            supabase.table("deliveries")
            .select("*, profiles(full_name)")
            .in_("transaction_id", delivery_tx_ids[offset:offset + ID_BATCH_SIZE])
            .execute()
            .data
        )
    deliveries_by_tx: dict[str, dict] = {}
    for row in delivery_rows:
        rider = row.pop("profiles", None) or {}
        row["rider_name"] = rider.get("full_name")
        deliveries_by_tx[row["transaction_id"]] = row
    for t in transactions:
        if t["id"] in deliveries_by_tx:
            t["delivery"] = deliveries_by_tx[t["id"]]
    # Approved online deliveries keep their delivery row on the digital order.
    missing = [t["id"] for t in transactions if t.get("order_type") == "delivery" and not t["delivery"]]
    for offset in range(0, len(missing), ID_BATCH_SIZE):
        linked = (supabase.table("digital_orders")
                  .select("transaction_id, deliveries(*, profiles(full_name))")
                  .in_("transaction_id", missing[offset:offset + ID_BATCH_SIZE]).execute().data)
        for row in linked:
            found = row.get("deliveries") or []
            found = found if isinstance(found, list) else [found]
            if found:
                delivery = found[-1]
                rider = delivery.pop("profiles", None) or {}
                delivery["rider_name"] = rider.get("full_name")
                for t in transactions:
                    if t["id"] == row["transaction_id"]:
                        t["delivery"] = delivery


def delivery_row_for_transaction(db, transaction_id: str) -> dict | None:
    """The deliveries row of a POS delivery (by transaction) or of an
    approved online delivery (by its digital order)."""
    row = db.table("deliveries").select("*").eq("transaction_id", transaction_id).limit(1).execute().data
    if row:
        return row[0]
    linked = db.table("digital_orders").select("id").eq("transaction_id", transaction_id).limit(1).execute().data
    if not linked:
        return None
    row = db.table("deliveries").select("*").eq("digital_order_id", linked[0]["id"]).limit(1).execute().data
    return row[0] if row else None


def _attach_planned_flags(supabase, transactions: list[dict]) -> None:
    """Flags sales that came from a hanged order or a scheduled online order,
    so the Kitchen Display keeps them out of the overdue queue."""
    ids = [t["id"] for t in transactions]
    hanged: set[str] = set()
    scheduled: set[str] = set()
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        chunk = ids[offset:offset + ID_BATCH_SIZE]
        try:
            hanged.update(r["transaction_id"] for r in supabase.table("pos_hanged_orders")
                          .select("transaction_id").in_("transaction_id", chunk).execute().data)
        except APIError:
            pass
        try:
            scheduled.update(r["transaction_id"] for r in supabase.table("digital_orders")
                             .select("transaction_id").in_("transaction_id", chunk)
                             .not_.is_("scheduled_for", "null").execute().data)
        except APIError:
            pass
    for t in transactions:
        t["is_hanged"] = t["id"] in hanged
        t["is_scheduled"] = t["id"] in scheduled


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
    # Batched: one `in` filter over every item id overflows the request URL.
    addon_rows: list[dict] = []
    for offset in range(0, len(item_ids), ID_BATCH_SIZE):
        addon_rows.extend(
            supabase.table("transaction_item_addons")
            .select("*, menu_addons(name)")
            .in_("transaction_item_id", item_ids[offset:offset + ID_BATCH_SIZE])
            .execute()
            .data
        )
    addons_by_item: dict[str, list] = defaultdict(list)
    for row in addon_rows:
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

    # Each write is a call to adjust_ingredient_stock (migration 0046), a
    # single atomic `current_stock = current_stock + delta` UPDATE -- not a
    # select-then-absolute-write. Two POS terminals selling the same
    # ingredient at nearly the same instant used to race here (both reading
    # the same current_stock, the second write silently discarding the
    # first's deduction); the RPC removes the read entirely so there's
    # nothing left to race on. PostgREST has no batched "add a different
    # delta to each row" primitive, so this stays one RPC call per recipe
    # line, same as the per-row UPDATE it replaces.
    deltas: dict[str, float] = {}
    movement_rows: list[dict] = []
    movement_type = "sale_consumption" if sign < 0 else "sale_consumption_reversal"
    for recipe_item in recipe_rows:
        ingredient_id = recipe_item["ingredient_id"]
        delta_qty = float(recipe_item["qty_per_serving"]) * quantity * sign
        supabase.rpc("adjust_ingredient_stock", {"p_id": ingredient_id, "p_delta": delta_qty}).execute()
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
    if not item_ids or not _bundle_fulfillments_supported_check(supabase):
        return set()
    return completed_bundle_ids(supabase, item_ids)


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
    pending_ids = pending_bundle_item_ids(supabase, [i["id"] for i in items])
    for item in items:
        item["bundle_fulfilled"] = item["id"] in fulfilled_ids
        item["bundle_deduction_status"] = ("pending_recipe" if item["id"] in pending_ids else "applied") if item["id"] in fulfilled_ids else None
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
    _attach_deliveries(supabase, [transaction])
    return transaction


def fetch_transaction_delivery_ticket(supabase, transaction_id: str) -> dict | None:
    """Adapter for the rider dispatch queue (deliveries.py): maps a POS-
    originated delivery transaction into the same shape DigitalOrderResponse
    already has, so the existing rider UI (Delivery.tsx/DeliveryMonitor.tsx)
    can render it with zero changes, regardless of whether the order started
    as a QR submission or a POS Charge. `id`/`digital_order_id` are both set
    to the transaction id -- the frontend only ever uses `order.id` as a
    React key and to call markDeliveryDone(order.id), never to look up a
    real digital_orders row, so this is a safe stand-in, not a lie about
    provenance (order_channel="delivery" + status="approved" already make
    that explicit)."""
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction or transaction.get("order_type") != "delivery" or not transaction.get("delivery"):
        return None
    items = [
        {
            "id": item["id"],
            "digital_order_id": transaction_id,
            "product_size_id": item["product_size_id"],
            "quantity": item["quantity"],
            "unit_price": item["unit_price"],
            "held_ingredients": item.get("held_ingredients") or [],
        }
        for item in transaction["items"]
    ]
    addons = [
        {
            "id": addon["id"],
            "digital_order_id": transaction_id,
            "addon_id": addon["addon_id"],
            "addon_name": addon.get("addon_name"),
            "quantity": addon["quantity"],
            "unit_price": addon["unit_price"],
        }
        for item in transaction["items"]
        for addon in item.get("addons") or []
    ]
    return {
        "id": transaction_id,
        "order_number": transaction.get("order_number") or 0,
        "table_number": None,
        "order_channel": "delivery",
        "status": "approved",
        "payment_method": (
            f"COLLECT CASH: PHP {float(transaction['total_amount']):,.2f}"
            if transaction.get("payment_status") == "unpaid"
            else transaction.get("payment_method") or "cash"
        ),
        "payment_proof_url": None,
        "customer_note": None,
        "subtotal": transaction["total_amount"],
        "approved_by": None,
        "approved_at": transaction["opened_at"],
        "rejected_reason": None,
        "transaction_id": transaction_id,
        "created_at": transaction["opened_at"],
        "items": items,
        "addons": addons,
        "delivery": transaction["delivery"],
    }


def _prepare_items(supabase, items: list, discount_type_id: str | None, force_vat_exempt: bool):
    """Validates a sale's lines before anything is written: sizes and
    add-ons exist (add-on prices come from menu_addons, never the client),
    at most one discount, and the discount type is active. Returns
    (sizes_by_id, addons_by_id, discounted_item_index, discount,
    selected_discount_type_id, vat_exempt). Shared by sale creation and the
    advance-order item edit."""
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

    discounted_item_index = _single_discount_item_index(items, discount_type_id)
    if discounted_item_index is not None and not _item_discounts_supported_check(supabase):
        raise HTTPException(status_code=501, detail="Item discounts need database migration 0070")
    selected_discount_type_id = (
        items[discounted_item_index].discount_type_id
        if discounted_item_index is not None else discount_type_id
    )
    discount = None
    discount_amount = 0.0
    vat_exempt = False
    if selected_discount_type_id:
        discount_result = (
            supabase.table("discount_types")
            .select("*")
            .eq("id", selected_discount_type_id)
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

    return sizes_by_id, addons_by_id, discounted_item_index, discount, selected_discount_type_id, vat_exempt


def _write_items_and_totals(
    supabase, transaction_id: str, employee_id: str, items: list, sizes_by_id: dict, addons_by_id: dict,
    discounted_item_index: int | None, discount: dict | None, selected_discount_type_id: str | None,
    vat_exempt: bool, order_type: str | None, guest_count: int | None, kept_subtotal: float = 0.0,
) -> tuple[dict, list[dict]]:
    """Inserts a sale's item (+ add-on) rows, deducts their stock, and
    writes the discount/tax/total onto the transaction. Returns
    (transaction_row, inserted_items). Shared by sale creation and the
    advance-order item edit; the edit passes kept_subtotal for lines it
    leaves in place (made bundles), so totals cover the whole order."""
    discount_amount = 0.0
    held_ingredients_supported = _held_ingredients_supported_check(supabase)

    addons_supported = _transaction_item_addons_supported_check(supabase)

    subtotal = kept_subtotal
    item_rows = []
    for item_index, item in enumerate(items):
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
        if discounted_item_index is not None:
            # Bulk PostgREST inserts turn fields omitted from only some
            # rows into NULL. Both columns are NOT NULL in migration 0070.
            row["discount_amount"] = 0.0
            row["discount_vat_exempt"] = False
        if item_index == discounted_item_index and discount:
            # Only one product unit is discounted; add-ons and other units
            # retain their full price. Snapshot the label for later reprints.
            discount_amount = _one_unit_discount(unit_price, discount["percentage"])
            row.update({
                "discount_type_id": selected_discount_type_id,
                "discount_name": discount["name"],
                "discount_percentage": discount["percentage"],
                "discount_vat_exempt": discount["vat_exempt"],
                "discount_amount": discount_amount,
            })
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
    elif item_rows:
        inserted_items = supabase.table("transaction_items").insert(item_rows).execute().data
    else:
        inserted_items = []
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

    if discount and discounted_item_index is None:
        discount_amount = subtotal * (discount["percentage"] / 100)
    discounted_subtotal = subtotal - discount_amount
    tax_amount = 0.0 if vat_exempt else discounted_subtotal * _get_vat_rate(supabase)

    updated = (
        supabase.table("transactions")
        .update(
            {
                "total_amount": discounted_subtotal,
                "discount_type_id": selected_discount_type_id,
                "discount_amount": discount_amount,
                "tax_amount": tax_amount,
            }
        )
        .eq("id", transaction_id)
        .execute()
    )
    return updated.data[0], inserted_items


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
    related_transaction_id: str | None = None,
    delivery: DeliveryCaptureIn | None = None,
    delivery_fee_override: float | None = None,
    pay_on_delivery: bool = False,
    order_source: str = "pos",
    scheduled_for: datetime | None = None,
    pickup_customer_name: str | None = None,
    pickup_customer_phone: str | None = None,
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
    sizes_by_id, addons_by_id, discounted_item_index, discount, selected_discount_type_id, vat_exempt = (
        _prepare_items(supabase, items, discount_type_id, force_vat_exempt)
    )

    # Walk-in delivery (0051): validated and the fee looked up *before* the
    # transaction row is inserted below -- same reasoning as the item and
    # discount checks just above, everything that can 400 happens before any write,
    # so an invalid barangay never leaves an orphaned open transaction with
    # no items behind. The fee is looked up server-side, exactly like
    # digital_menu.py's submit_digital_order -- never trusted from the client.
    delivery_fee: float | None = None
    if order_type == "delivery" and delivery and _deliveries_transaction_id_supported_check(supabase):
        if delivery_fee_override is not None:
            delivery_fee = round(delivery_fee_override, 2)
        else:
            fee_result = (
                supabase.table("delivery_fees")
                .select("fee")
                .eq("barangay", delivery.barangay)
                .maybe_single()
                .execute()
            )
            if not fee_result or not fee_result.data:
                raise HTTPException(status_code=400, detail=f"No delivery fee configured for {delivery.barangay}")
            delivery_fee = float(fee_result.data["fee"])

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
    if _transaction_order_source_supported_check(supabase):
        insert_payload["order_source"] = order_source
    if _transaction_card_vat_supported_check(supabase):
        insert_payload["card_type"] = card_type
        insert_payload["force_vat_exempt"] = force_vat_exempt
    if related_transaction_id:
        insert_payload["related_transaction_id"] = related_transaction_id
    if pay_on_delivery:
        if not _payment_status_supported_check(supabase):
            raise HTTPException(status_code=501, detail="Deferred payment needs database migration 0062")
        insert_payload["payment_status"] = "unpaid"
    if scheduled_for is not None:
        if not _advance_supported_check(supabase):
            raise HTTPException(status_code=501, detail="Advance orders need database migration 0068")
        insert_payload.update({
            "scheduled_for": scheduled_for.isoformat(),
            "pickup_customer_name": pickup_customer_name,
            "pickup_customer_phone": pickup_customer_phone,
        })

    transaction_insert = supabase.table("transactions").insert(insert_payload).execute()
    transaction = transaction_insert.data[0]
    transaction_id = transaction["id"]

    # Stage the validated delivery capture in the *same* `deliveries` table
    # used by QR-originated deliveries (transaction_id instead of
    # digital_order_id) so it shows up in the existing rider dispatch queue
    # (deliveries.py) unchanged -- never a second, parallel table.
    delivery_out: dict | None = None
    if delivery_fee is not None and delivery:
        delivery_row = {
            "transaction_id": transaction_id,
            "customer_name": delivery.customer_name,
            "customer_phone": delivery.customer_phone,
            "address": delivery.address,
            "landmark": delivery.landmark,
            "barangay": delivery.barangay,
            "delivery_fee": delivery_fee,
        }
        inserted_delivery = supabase.table("deliveries").insert(delivery_row).execute().data[0]
        inserted_delivery["rider_name"] = None
        delivery_out = inserted_delivery

    transaction, inserted_items = _write_items_and_totals(
        supabase, transaction_id, employee_id, items, sizes_by_id, addons_by_id,
        discounted_item_index, discount, selected_discount_type_id, vat_exempt,
        order_type, guest_count,
    )
    transaction.setdefault("kitchen_status", "queued")
    transaction.setdefault("order_number", None)
    transaction.setdefault("order_type", None)
    transaction.setdefault("order_source", order_source)
    transaction.setdefault("table_number", None)
    transaction.setdefault("guest_count", None)
    transaction.setdefault("payment_method", None)
    transaction.setdefault("card_type", None)
    transaction.setdefault("force_vat_exempt", False)
    return TransactionResponse(**transaction, items=inserted_items, delivery=delivery_out)


def _validate_grab_settlement(order_source: str, payment_method: str | None,
                              pay_on_delivery: bool = False, pay_on_pickup: bool = False) -> None:
    if order_source == "grab":
        if payment_method != "grab" or pay_on_delivery or pay_on_pickup:
            raise HTTPException(status_code=400, detail="Grab orders require Grab settlement")
    elif payment_method == "grab":
        raise HTTPException(status_code=400, detail="Grab settlement is only for Grab orders")


@router.post("/transactions", response_model=TransactionResponse)
def create_transaction(body: CreateTransactionRequest, user: CurrentUser = Depends(get_current_user)):
    """Create a sale via the POS. Auth/ownership and Owner's Request
    re-verification happen here; the actual insert/deduction/discount logic
    lives in _create_transaction_row, shared with digital-menu order
    approval."""
    # The kitchen tablet / kitchen crew never charge sales (tablet lock).
    if user.role == "kitchen":
        raise HTTPException(status_code=403, detail="Kitchen accounts can't charge sales")
    supabase = get_supabase()
    existing_id = check_idempotency_key(supabase, body.idempotency_key, "POST /transactions")
    if existing_id:
        return get_transaction(existing_id, user)

    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot record a sale under another employee's id")
    if body.order_type == "dine_in" and not body.table_number:
        raise HTTPException(status_code=400, detail="Table number is required for dine-in orders")
    if body.order_type == "delivery" and not body.delivery:
        raise HTTPException(status_code=400, detail="Customer/address details are required for delivery orders")
    # Payment method is a hard requirement at the POS (unlike a discount) so the
    # till reconciles. The digital-order approval path doesn't come through here.
    if body.pay_on_delivery and body.order_type != "delivery":
        raise HTTPException(status_code=400, detail="Pay on delivery is only for delivery orders")
    if body.pay_on_pickup and (body.order_type != "takeout" or body.scheduled_for is None):
        raise HTTPException(status_code=400, detail="Pay at pickup requires an advance takeout order")
    if body.pay_on_pickup and body.pay_on_delivery:
        raise HTTPException(status_code=400, detail="Choose one deferred payment option")
    _validate_grab_settlement(body.order_source, body.payment_method, body.pay_on_delivery, body.pay_on_pickup)
    if body.pay_on_delivery and not body.payment_method:
        body.payment_method = "cash"  # what the rider will collect
    if not body.payment_method and not body.pay_on_pickup:
        raise HTTPException(status_code=400, detail="Payment method is required")
    if body.pay_on_pickup and (body.payment_method or body.card_type):
        raise HTTPException(status_code=400, detail="Choose the payment method when payment is received")
    if body.payment_method == "card" and not body.card_type:
        raise HTTPException(status_code=400, detail="Select debit or credit")
    scheduled_for = None
    if body.scheduled_for is not None:
        if body.order_type not in ("takeout", "delivery") or body.related_transaction_id:
            raise HTTPException(status_code=400, detail="Advance orders must be new takeout or delivery orders")
        scheduled_for = _validate_advance_time(body.scheduled_for)
        if body.order_type == "takeout" and (not (body.pickup_customer_name or "").strip() or not (body.pickup_customer_phone or "").strip()):
            raise HTTPException(status_code=400, detail="Pickup customer name and phone are required")
    elif body.pickup_customer_name or body.pickup_customer_phone:
        raise HTTPException(status_code=400, detail="Pickup details require an advance takeout order")

    # WS-13: Business Day lock -- backend defense to match the frontend
    # overlay (POSTerminal.tsx), same belt-and-braces posture as the
    # kitchen-completed void guard. Executives are exempt -- the admin
    # account needs to be able to use POS regardless of whether a cashier
    # has started the day (e.g. testing, an ad-hoc sale, covering a shift).
    if user.role != "executive" and _business_days_supported_check(supabase):
        from app.routers.business_days import fetch_open_shift
        if not fetch_open_shift(supabase):
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

    # Add Order (WS-14): additional items for an already-completed
    # transaction get rung up as their own charge/kitchen ticket, linked
    # back to the original rather than mutating a closed one.
    if body.related_transaction_id:
        parent = (
            supabase.table("transactions")
            .select("id, status")
            .eq("id", body.related_transaction_id)
            .maybe_single()
            .execute()
        )
        if not parent or not parent.data:
            raise HTTPException(status_code=404, detail="Original order not found")
        if parent.data["status"] != "closed":
            raise HTTPException(status_code=400, detail="Can only add an order to a completed (closed) transaction")

    # Reservation block: a confirmed reservation holds its table in the POS
    # for [start - prep buffer, end). A manager can override, which mints a
    # single-use reservation_overrides row (see /pos/tables/override).
    # Skipped entirely for an Add Order sale (related_transaction_id set) --
    # the parent transaction already legitimately occupied this table for
    # this party; re-running the walk-in block/capacity check here would
    # wrongly 409 the common case of adding items to a reservation's own
    # still-active table.
    consumed_override_id = None
    blocked_table = None
    if body.order_type == "dine_in" and not body.related_transaction_id:
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
        related_transaction_id=body.related_transaction_id,
        delivery=body.delivery,
        delivery_fee_override=body.delivery_fee,
        pay_on_delivery=body.pay_on_delivery or body.pay_on_pickup,
        order_source=body.order_source,
        scheduled_for=scheduled_for,
        pickup_customer_name=body.pickup_customer_name.strip() if body.pickup_customer_name else None,
        pickup_customer_phone=body.pickup_customer_phone.strip() if body.pickup_customer_phone else None,
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

    record_idempotency_key(supabase, body.idempotency_key, "POST /transactions", result.id)
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


# The kitchen tablet and every cashier and TV screen poll the same live lists.
# A built response (JSON bytes) is reused until the database's change counter
# (live_version, migration 0077) moves: any write to a table these lists read
# bumps it. Checking the counter is one ~100-byte request at most every
# VERSION_CHECK_SECONDS per instance, where a rebuild downloads the whole list
# -- this is what keeps Supabase egress and log volume inside the free plan.
# Without migration 0077 it falls back to a plain 10 s cache.
_LIVE_CACHE_SECONDS = 10
VERSION_CHECK_SECONDS = 5
# Safety net for anything the triggers don't cover.
_LIVE_CACHE_MAX_AGE_SECONDS = 300
_live_cache: dict = {}
_live_cache_lock = threading.Lock()
_transactions_json = TypeAdapter(list[TransactionResponse])
_version_state = {"supported": None, "value": None, "checked_at": 0.0}


def current_live_version(supabase=None) -> int | None:
    """The change counter, read at most once per VERSION_CHECK_SECONDS.
    None when migration 0077 isn't applied."""
    now = time.monotonic()
    with _live_cache_lock:
        if _version_state["supported"] is False:
            return None
        if _version_state["value"] is not None and now - _version_state["checked_at"] < VERSION_CHECK_SECONDS:
            return _version_state["value"]
    try:
        rows = (supabase or get_supabase()).table("live_version").select("version").eq("id", 1).execute().data
    except APIError:
        with _live_cache_lock:
            _version_state["supported"] = False
        return None
    value = int(rows[0]["version"]) if rows else None
    with _live_cache_lock:
        _version_state.update(supported=value is not None, value=value, checked_at=now)
    return value


def expire_version_check() -> None:
    """After a write on this instance: check the counter on the next read,
    so the screen that made the change sees it straight away."""
    with _live_cache_lock:
        _version_state["checked_at"] = 0.0
        gated = _version_state["supported"] is True
    if not gated:
        clear_live_cache()


def clear_live_cache() -> None:
    with _live_cache_lock:
        _live_cache.clear()


def live_cache_get(key) -> bytes | None:
    version = current_live_version()
    now = time.monotonic()
    with _live_cache_lock:
        entry = _live_cache.get(key)
    if entry is None:
        return None
    built_version, built_at, body = entry
    if version is None:
        fresh = built_version is None and now - built_at < _LIVE_CACHE_SECONDS
    else:
        fresh = built_version == version and now - built_at < _LIVE_CACHE_MAX_AGE_SECONDS
    return body if fresh else None


def live_cache_version() -> int | None:
    """Read before building, so a change mid-build is caught by the next check."""
    return current_live_version()


def live_cache_put(key, body: bytes, version: int | None = None) -> Response:
    with _live_cache_lock:
        if len(_live_cache) >= 64:
            _live_cache.pop(next(iter(_live_cache)))
        _live_cache[key] = (version, time.monotonic(), body)
    return Response(body, media_type="application/json")


def _embedded_transactions(supabase, columns: str, narrow) -> list[dict]:
    """Every GET /transactions list (Kitchen Display, Order Queue, Floor Plan,
    advance orders, the print bridge) in ONE PostgREST request. `narrow` adds
    the filters and ordering to the query.

    The general path below looks up addons, bundle state, deliveries and
    planned flags with `in.(<every item id>)` filters -- by evening that's
    six URLs carrying ~280 UUIDs each, and httpx validates every character of
    them in pure Python. Profiled at ~100 ms CPU per call, polled all day by
    the kitchen tablet: that alone used up Vercel Hobby's monthly Active CPU
    (paused 2026-10-16). Embedding the same rows through their foreign keys
    gives an identical response for a fraction of the CPU.

    Assumes every migration through 0075 is applied; any APIError (missing
    table/relationship) makes the caller fall back to the general path.
    """
    item_columns = (
        "id, transaction_id, product_size_id, quantity, unit_price, held_ingredients, "
        "discount_type_id, discount_name, discount_percentage, discount_vat_exempt, discount_amount"
    )
    select = (
        f"{columns}, "
        f"transaction_items({item_columns}, "
        "transaction_item_addons(*, menu_addons(name)), "
        "bundle_fulfillment_batches(restored_at, bundle_pending_deductions(resolved_at)), "
        "bundle_fulfillments(quantity), "
        "product_sizes(bundle_components(total_pieces))), "
        "deliveries(*, profiles(full_name)), "
        "pos_hanged_orders(transaction_id), "
        "digital_orders(scheduled_for, deliveries(*, profiles(full_name)))"
    )
    transactions = _page_rows(narrow(supabase.table("transactions").select(select)))

    def as_list(value) -> list:
        if value is None:
            return []
        return value if isinstance(value, list) else [value]

    for t in transactions:
        items = t.pop("transaction_items", None) or []
        for item in items:
            addons = []
            for row in item.pop("transaction_item_addons", None) or []:
                addon_info = row.pop("menu_addons", None) or {}
                row["addon_name"] = addon_info.get("name")
                addons.append(row)
            item["addons"] = addons

            # Same rules as bundles.completed_bundle_ids / pending_bundle_item_ids.
            batches = as_list(item.pop("bundle_fulfillment_batches", None))
            legacy = item.pop("bundle_fulfillments", None) or []
            size = item.pop("product_sizes", None) or {}
            if batches:
                fulfilled = any(b.get("restored_at") is None for b in batches)
            elif legacy:
                config = size.get("bundle_components")
                if isinstance(config, list):
                    config = config[0] if len(config) == 1 else None
                total = sum(r["quantity"] for r in legacy)
                fulfilled = bool(config) and total == float(item["quantity"]) * config["total_pieces"]
            else:
                fulfilled = False
            pending = any(
                p.get("resolved_at") is None
                for b in batches for p in as_list(b.get("bundle_pending_deductions"))
            )
            item["bundle_fulfilled"] = fulfilled
            item["bundle_deduction_status"] = ("pending_recipe" if pending else "applied") if fulfilled else None
        t["_items"] = items

        deliveries = as_list(t.pop("deliveries", None))
        digital = as_list(t.pop("digital_orders", None))
        if not deliveries:
            # Approved online deliveries keep their delivery row on the digital order.
            deliveries = [d for order in digital for d in as_list(order.get("deliveries"))]
        t["delivery"] = None
        if t.get("order_type") == "delivery" and deliveries:
            row = deliveries[-1]
            rider = row.pop("profiles", None) or {}
            row["rider_name"] = rider.get("full_name")
            t["delivery"] = row
        t["is_hanged"] = bool(as_list(t.pop("pos_hanged_orders", None)))
        t["is_scheduled"] = any(d.get("scheduled_for") for d in digital)
    return transactions


@router.get("/transactions", response_model=list[TransactionResponse])
def list_transactions(
    on_date: date | None = Query(None, alias="date"),
    status_filter: str | None = Query(None, alias="status"),
    kitchen_status: KitchenStatus | None = Query(None),
    advance_order_type: Literal["takeout", "delivery"] | None = Query(None),
    advance_from: datetime | None = Query(None),
    advance_before: datetime | None = Query(None),
    active_since: date | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """`active_since` limits the list to orders still needing attention
    (kitchen not completed, or payment unpaid) plus everything opened on or
    after that PH date, so live boards don't load the whole order history."""
    cache_key = tuple(str(v) for v in (on_date, status_filter, kitchen_status, advance_order_type,
                                       advance_from, advance_before, active_since))
    body = live_cache_get(cache_key)
    if body is not None:
        return Response(body, media_type="application/json")
    version = live_cache_version()
    supabase = get_supabase()
    # Release approved advance orders that are now within their kitchen lead
    # window, so they show up in this very response. Imported lazily because
    # digital_menu already imports this module. Never raises.
    from app.routers.digital_menu import fire_due_scheduled_orders

    fire_due_scheduled_orders(supabase)
    columns = (
        "id, employee_id, status, opened_at, closed_at, total_amount, discount_type_id, "
        "discount_amount, tax_amount, is_owner_request, owner_request_by, owner_request_note, "
        "voided_by, voided_at, void_reason, kitchen_status, kitchen_status_updated_at, "
        "order_type, table_number, guest_count, payment_method, related_transaction_id"
    )
    if _transaction_order_source_supported_check(supabase):
        columns += ", order_source"
    if _transaction_order_number_supported_check(supabase):
        columns += ", order_number"
    if _payment_status_supported_check(supabase):
        columns += ", payment_status, paid_at"
    if _advance_supported_check(supabase):
        columns += ", scheduled_for, pickup_customer_name, pickup_customer_phone, advance_schedule_revision, advance_schedule_updated_at, advance_schedule_updated_by"
    elif advance_order_type:
        raise HTTPException(status_code=501, detail="Advance orders need database migration 0068")
    if _kitchen_reprint_supported_check(supabase):
        columns += ", kitchen_reprint_requested_at"
    # Each filter is kept as a function so the one-request embedded read and
    # the general fallback below apply exactly the same ones.
    filters = []
    if on_date:
        start, end = ph_day_bounds_utc(on_date)
        filters.append(lambda q: q.gte("opened_at", start).lte("opened_at", end))
    if status_filter:
        filters.append(lambda q: q.eq("status", status_filter))
    if active_since:
        since_start, _ = ph_day_bounds_utc(active_since)
        active = [f"opened_at.gte.{since_start}"]
        if _kitchen_status_supported_check(supabase):
            active.append("kitchen_status.neq.completed")
        if _payment_status_supported_check(supabase):
            active.append("payment_status.eq.unpaid")
        if _kitchen_reprint_supported_check(supabase):
            # A reprint asked for in the last hour reaches the kitchen tablet
            # even for a finished order opened before today.
            reprint_since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
            active.append(f"kitchen_reprint_requested_at.gte.{reprint_since}")
        active_filter = ",".join(active)
        filters.append(lambda q: q.or_(active_filter))
    if kitchen_status and _kitchen_status_supported_check(supabase):
        filters.append(lambda q: q.eq("kitchen_status", kitchen_status))
    if advance_order_type:
        if not advance_from or not advance_before or advance_from.tzinfo is None or advance_before.tzinfo is None or advance_before <= advance_from:
            raise HTTPException(status_code=400, detail="Advance order time range is required")
        filters.append(lambda q: (
            q.eq("order_type", advance_order_type).in_("order_source", ["pos", "grab"]).neq("status", "voided")
            .not_.is_("scheduled_for", "null")
            .gte("scheduled_for", advance_from.astimezone(timezone.utc).isoformat())
            .lt("scheduled_for", advance_before.astimezone(timezone.utc).isoformat())
        ))

    def narrow(q):
        for apply_filter in filters:
            q = apply_filter(q)
        if advance_order_type:
            return q.order("scheduled_for").order("id")
        return q.order("opened_at", desc=True).order("id")

    fast = _try_embedded(supabase, columns, narrow)
    if fast is not None:
        return _cached_response(cache_key, fast, version)

    query = narrow(supabase.table("transactions").select(columns))
    transactions = _page_rows(query) if kitchen_status or active_since or advance_order_type else query.execute().data
    if not transactions:
        return []

    transaction_ids = [t["id"] for t in transactions]
    all_items = []
    item_columns = "id, transaction_id, product_size_id, quantity, unit_price, held_ingredients"
    if _item_discounts_supported_check(supabase):
        item_columns += ", discount_type_id, discount_name, discount_percentage, discount_vat_exempt, discount_amount"
    for offset in range(0, len(transaction_ids), ID_BATCH_SIZE):
        item_query = (supabase.table("transaction_items")
                      .select(item_columns)
                      .in_("transaction_id", transaction_ids[offset:offset + ID_BATCH_SIZE]))
        all_items.extend(_page_rows(item_query.order("id")) if advance_order_type or kitchen_status else item_query.execute().data)
    fulfilled_ids = _bundle_fulfilled_item_ids(supabase, [i["id"] for i in all_items])
    pending_ids = pending_bundle_item_ids(supabase, [i["id"] for i in all_items])
    _attach_item_addons(supabase, all_items)
    items_by_transaction: dict[str, list] = defaultdict(list)
    for item in all_items:
        item["bundle_fulfilled"] = item["id"] in fulfilled_ids
        item["bundle_deduction_status"] = ("pending_recipe" if item["id"] in pending_ids else "applied") if item["id"] in fulfilled_ids else None
        items_by_transaction[item["transaction_id"]].append(item)

    _attach_deliveries(supabase, transactions)
    _attach_planned_flags(supabase, transactions)

    return [_transaction_response(t, items_by_transaction.get(t["id"], [])) for t in transactions]


def _cached_response(cache_key, transactions: list[TransactionResponse], version: int | None) -> Response:
    return live_cache_put(cache_key, _transactions_json.dump_json(transactions), version)


def _try_embedded(supabase, columns: str, narrow) -> list[TransactionResponse] | None:
    try:
        transactions = _embedded_transactions(supabase, columns, narrow)
    except APIError:
        return None
    return [_transaction_response(t, t.pop("_items")) for t in transactions]


def _transaction_response(t: dict, items: list) -> TransactionResponse:
    t.setdefault("kitchen_status", "queued")
    t.setdefault("order_number", None)
    t.setdefault("order_type", None)
    t.setdefault("order_source", "pos")
    t.setdefault("table_number", None)
    t.setdefault("guest_count", None)
    t.setdefault("payment_method", None)
    t.setdefault("card_type", None)
    t.setdefault("force_vat_exempt", False)
    return TransactionResponse(**t, items=items)


@router.get("/transactions/advance-orders", response_model=list[TransactionResponse])
def list_advance_orders(
    order_type: Literal["takeout", "delivery"] = Query(...),
    date_from: datetime = Query(...),
    date_before: datetime = Query(...),
    user: CurrentUser = Depends(get_current_user),
):
    return list_transactions(
        on_date=None, status_filter=None, kitchen_status=None,
        advance_order_type=order_type, advance_from=date_from,
        advance_before=date_before, active_since=None, user=user,
    )


@router.get("/transactions/{transaction_id}", response_model=TransactionResponse)
def get_transaction(transaction_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    items = transaction.pop("items")
    return TransactionResponse(**transaction, items=items)


@router.patch("/transactions/{transaction_id}/advance-schedule", response_model=TransactionResponse)
def reschedule_advance_order(
    transaction_id: str,
    body: RescheduleAdvanceOrderRequest,
    user: CurrentUser = Depends(get_current_user),
):
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="Only front-of-house staff can reschedule orders")
    supabase = get_supabase()
    if not _advance_supported_check(supabase):
        raise HTTPException(status_code=501, detail="Advance orders need database migration 0068")
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction or not transaction.get("scheduled_for"):
        raise HTTPException(status_code=404, detail="Advance order not found")
    current_due = datetime.fromisoformat(transaction["scheduled_for"].replace("Z", "+00:00"))
    if transaction["status"] != "open" or transaction.get("kitchen_status") != "queued" or current_due <= datetime.now(timezone.utc) + ADVANCE_LEAD:
        raise HTTPException(status_code=409, detail="This order has entered its kitchen preparation window")
    if transaction.get("advance_schedule_revision", 0) != body.expected_revision:
        raise HTTPException(status_code=409, detail="Schedule changed; refresh the order")
    new_due = _validate_advance_time(body.scheduled_for)
    if new_due == current_due.astimezone(timezone.utc):
        raise HTTPException(status_code=400, detail="Choose a different time")
    updated = (supabase.table("transactions")
               .update({"scheduled_for": new_due.isoformat(),
                        "advance_schedule_revision": body.expected_revision + 1,
                        "advance_schedule_updated_at": datetime.now(timezone.utc).isoformat(),
                        "advance_schedule_updated_by": user.id})
               .eq("id", transaction_id).eq("advance_schedule_revision", body.expected_revision)
               .eq("kitchen_status", "queued").eq("status", "open").execute())
    if not updated.data:
        raise HTTPException(status_code=409, detail="Order changed; refresh and try again")
    return get_transaction(transaction_id, user)


def _locked_bundle_item_ids(supabase, item_ids: list[str]) -> set[str]:
    """Bundle lines the kitchen has started logging rolls for. Their
    fulfillment rows hold the item in place (FK on delete restrict), so an
    edit must keep them as they are."""
    if not item_ids or not _bundle_fulfillments_supported_check(supabase):
        return set()
    locked = {r["transaction_item_id"] for r in supabase.table("bundle_fulfillments")
              .select("transaction_item_id").in_("transaction_item_id", item_ids).execute().data or []}
    if atomic_bundles_available(supabase):
        locked |= {r["transaction_item_id"] for r in supabase.table("bundle_fulfillment_batches")
                   .select("transaction_item_id").in_("transaction_item_id", item_ids).execute().data or []}
    return locked


@router.put("/transactions/{transaction_id}/advance-items", response_model=TransactionResponse)
def update_advance_items(
    transaction_id: str,
    body: UpdateAdvanceItemsRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Advance Orders' "Edit order": replaces an advance order's items in
    place (same order number), at any kitchen stage. Old items' stock is
    given back, the new items are deducted, and the totals are recomputed.
    The kitchen ticket goes back to queued, and the revision bump makes the
    Kitchen Display print an updated ticket. Payment status and method are
    left as they are -- the cashier collects or gives back the difference.

    Bundle lines whose rolls were already logged stay exactly as they are
    (the request must repeat them unchanged)."""
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="Only front-of-house staff can edit orders")
    override = body.override_key is not None
    if override:
        _require_override(user, body.override_key, body.reason)
    supabase = get_supabase()
    if not _advance_supported_check(supabase):
        raise HTTPException(status_code=501, detail="Advance orders need database migration 0068")
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction or not transaction.get("scheduled_for"):
        raise HTTPException(status_code=404, detail="Advance order not found")
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="This order was voided")
    revision = transaction.get("advance_schedule_revision", 0)
    if revision != body.expected_revision:
        raise HTTPException(status_code=409, detail="Order changed; refresh and try again")

    # Made bundle lines stay: match each to an unchanged line in the request.
    locked_ids = _locked_bundle_item_ids(supabase, [i["id"] for i in transaction["items"]])
    kept = [i for i in transaction["items"] if i["id"] in locked_ids]
    remaining = list(body.items)
    for row in kept:
        match = next((line for line in remaining if line.product_size_id == row["product_size_id"]
                      and float(line.quantity) == float(row["quantity"])), None)
        if match is None:
            raise HTTPException(status_code=400, detail="A bundle the kitchen already made can't be removed or changed -- void the order instead")
        remaining.remove(match)
        if (row.get("discount_amount") or 0) > 0:
            raise HTTPException(status_code=400, detail="This order's discounted bundle can't be edited -- void the order instead")
    kept_subtotal = sum(float(r["unit_price"]) * float(r["quantity"])
                        + sum(float(a["unit_price"]) * float(a["quantity"]) for a in r.get("addons") or [])
                        for r in kept)

    # A line may only keep a discount the order already had -- the edit
    # dialog can't grant new ones.
    allowed_discounts = {i["discount_type_id"] for i in transaction["items"] if i.get("discount_type_id")}
    if any(i.discount_type_id and i.discount_type_id not in allowed_discounts for i in remaining):
        raise HTTPException(status_code=400, detail="Discounts can't be added while editing an advance order")
    order_discount = None if allowed_discounts else transaction.get("discount_type_id")
    force_vat_exempt = bool(transaction.get("force_vat_exempt"))
    if remaining:
        sizes_by_id, addons_by_id, discounted_item_index, discount, selected_discount_type_id, vat_exempt = (
            _prepare_items(supabase, remaining, order_discount, force_vat_exempt)
        )
    else:
        sizes_by_id, addons_by_id, discounted_item_index, discount, selected_discount_type_id, vat_exempt = (
            {}, {}, None, None, None, force_vat_exempt
        )
        if order_discount:
            _, _, _, discount, selected_discount_type_id, vat_exempt = _prepare_items(
                supabase, [TransactionItemCreate(product_size_id=kept[0]["product_size_id"], quantity=1)],
                order_discount, force_vat_exempt)

    now_iso = datetime.now(timezone.utc).isoformat()
    claim = {"advance_schedule_revision": revision + 1,
             "advance_schedule_updated_at": now_iso,
             "advance_schedule_updated_by": user.id}
    # A CEO override edit of a finished order doesn't send it back to the kitchen.
    if not (override and transaction.get("kitchen_status") == "completed"):
        claim.update({"kitchen_status": "queued", "kitchen_status_updated_at": now_iso})
    claimed = (supabase.table("transactions")
               .update(claim)
               .eq("id", transaction_id).eq("advance_schedule_revision", revision)
               .neq("status", "voided").execute())
    if not claimed.data:
        raise HTTPException(status_code=409, detail="Order changed; refresh and try again")

    replaced = [i for i in transaction["items"] if i["id"] not in locked_ids]
    # An unmade bundle took no stock, and restoring it would seal it with a
    # batch row that blocks the delete -- give back only the regular lines.
    size_ids = list({i["product_size_id"] for i in replaced})
    bundle_sizes = {r["id"] for r in (supabase.table("product_sizes").select("id, products(is_bundle)")
                                      .in_("id", size_ids).execute().data if size_ids else [])
                    if (r.get("products") or {}).get("is_bundle")}
    _restore_items_stock(supabase, {**transaction, "items": [i for i in replaced if i["product_size_id"] not in bundle_sizes]}, user.id)
    if replaced:
        supabase.table("transaction_items").delete().in_("id", [i["id"] for i in replaced]).execute()
    _write_items_and_totals(
        supabase, transaction_id, user.id, remaining, sizes_by_id, addons_by_id,
        discounted_item_index, discount, selected_discount_type_id, vat_exempt,
        transaction.get("order_type"), transaction.get("guest_count"), kept_subtotal=kept_subtotal,
    )
    if override:
        _log_override("edit items", transaction, user, body.reason)
    return get_transaction(transaction_id, user)


# --- CEO override on Advance Orders -----------------------------------------
# Executive + their own override key (0076) + a reason, for every action.
# These skip the cashier limits (preparation window, queued-only void).

class AdvanceOverrideRequest(BaseModel):
    override_key: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=500)


class AdvanceOverrideCompleteRequest(AdvanceOverrideRequest):
    payment_method: TransactionPaymentMethod | None = None
    card_type: TransactionCardType | None = None


class AdvanceOverrideScheduleRequest(AdvanceOverrideRequest):
    scheduled_for: datetime
    expected_revision: int = Field(ge=0)


class AdvanceOverrideCustomerRequest(AdvanceOverrideRequest):
    name: str = Field(min_length=1, max_length=120)
    phone: str = Field(min_length=1, max_length=40)
    address: str | None = Field(default=None, max_length=300)
    barangay: str | None = Field(default=None, max_length=120)
    landmark: str | None = Field(default=None, max_length=300)


def _require_override(user: CurrentUser, key: str | None, reason: str | None) -> None:
    require_role(user, "executive")
    if not (reason or "").strip():
        raise HTTPException(status_code=400, detail="Give a reason for the override")
    if not verify_override_key(user, key or ""):
        raise HTTPException(status_code=403, detail="Override key is wrong, or you haven't set one yet (Settings)")


def _log_override(action: str, transaction: dict, user: CurrentUser, reason: str | None) -> None:
    logger.warning("Advance override %s: #%s (%s) by %s (%s). Reason: %s", action,
                   transaction.get("order_number"), transaction["id"], user.full_name, user.id, (reason or "").strip())


def _override_target(supabase, transaction_id: str, user: CurrentUser, body: AdvanceOverrideRequest) -> dict:
    _require_override(user, body.override_key, body.reason)
    if not _advance_supported_check(supabase):
        raise HTTPException(status_code=501, detail="Advance orders need database migration 0068")
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction or not transaction.get("scheduled_for"):
        raise HTTPException(status_code=404, detail="Advance order not found")
    return transaction


def _bump_revision(supabase, transaction: dict, user: CurrentUser, extra: dict | None = None,
                   reprint: bool = False) -> None:
    """Only from the revision we read, so a cashier's edit made meanwhile isn't
    overwritten (409). A queued ticket reprints by itself on the new revision;
    one the kitchen already took (preparing/ready) is sent as a REPRINT copy
    when `reprint`, so the kitchen sees the change."""
    revision = transaction.get("advance_schedule_revision") or 0
    patch = {
        "advance_schedule_revision": revision + 1,
        "advance_schedule_updated_at": datetime.now(timezone.utc).isoformat(),
        "advance_schedule_updated_by": user.id,
        **(extra or {}),
    }
    if reprint and transaction.get("kitchen_status") in ("preparing", "ready") and _kitchen_reprint_supported_check(supabase):
        patch["kitchen_reprint_requested_at"] = patch["advance_schedule_updated_at"]
    updated = (supabase.table("transactions").update(patch).eq("id", transaction["id"])
               .eq("advance_schedule_revision", revision).execute())
    if not updated.data:
        raise HTTPException(status_code=409, detail="Order changed; refresh and try again")


@router.post("/transactions/{transaction_id}/advance-override/complete", response_model=TransactionResponse)
def override_complete_advance(transaction_id: str, body: AdvanceOverrideCompleteRequest,
                              user: CurrentUser = Depends(get_current_user)):
    """Force complete: records the payment if it's still unpaid, marks a
    delivery delivered, and closes the order -- at any stage, even before
    its kitchen window opens."""
    supabase = get_supabase()
    transaction = _override_target(supabase, transaction_id, user, body)
    if transaction["status"] == "voided":
        raise HTTPException(status_code=409, detail="This order was voided")
    now_iso = datetime.now(timezone.utc).isoformat()
    revision = transaction.get("advance_schedule_revision") or 0
    # Payment, close, kitchen done and the revision go in one guarded update,
    # so the order is never left half-done (e.g. paid but still open).
    patch = {
        "kitchen_status": "completed", "kitchen_status_updated_at": now_iso,
        "advance_schedule_revision": revision + 1, "advance_schedule_updated_at": now_iso,
        "advance_schedule_updated_by": user.id,
    }
    if transaction["status"] == "open":
        patch.update(status="closed", closed_at=now_iso)
    unpaid = transaction.get("payment_status") == "unpaid"
    if unpaid:
        if not body.payment_method:
            raise HTTPException(status_code=400, detail="Choose how it was paid")
        _validate_grab_settlement(transaction.get("order_source") or "pos", body.payment_method)
        if body.payment_method == "card" and not body.card_type:
            raise HTTPException(status_code=400, detail="Select debit or credit")
        if body.payment_method != "card" and body.card_type:
            raise HTTPException(status_code=400, detail="Card type requires card payment")
        patch.update(payment_status="paid", paid_at=now_iso, paid_by=user.id,
                     payment_method=body.payment_method, card_type=body.card_type)
    # The delivery is marked first and put back if the order can't be completed.
    delivered_id = None
    if transaction.get("order_type") == "delivery":
        delivery = delivery_row_for_transaction(supabase, transaction_id)
        if delivery and not delivery.get("delivered_at"):
            supabase.table("deliveries").update({"delivered_at": now_iso}).eq("id", delivery["id"]).execute()
            delivered_id = delivery["id"]
    query = (supabase.table("transactions").update(patch).eq("id", transaction_id)
             .eq("status", transaction["status"]).eq("advance_schedule_revision", revision))
    if unpaid:
        query = query.eq("payment_status", "unpaid")
    if not query.execute().data:
        if delivered_id:
            supabase.table("deliveries").update({"delivered_at": None}).eq("id", delivered_id).execute()
        raise HTTPException(status_code=409, detail="Order changed; refresh and try again")
    _log_override("complete", transaction, user, body.reason)
    return get_transaction(transaction_id, user)


@router.post("/transactions/{transaction_id}/advance-override/void", response_model=TransactionResponse)
def override_void_advance(transaction_id: str, body: AdvanceOverrideRequest,
                          user: CurrentUser = Depends(get_current_user)):
    """Cancel at any kitchen stage. Stock is returned; the order stays in
    reports as voided with the reason."""
    supabase = get_supabase()
    transaction = _override_target(supabase, transaction_id, user, body)
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="This order is already voided")
    updated_row, items = void_transaction_core(supabase, transaction, user.id, f"CEO override: {body.reason.strip()}")
    _log_override("void", transaction, user, body.reason)
    return TransactionResponse(**updated_row, items=items)


@router.post("/transactions/{transaction_id}/advance-override/erase")
def override_erase_advance(transaction_id: str, body: AdvanceOverrideRequest,
                           user: CurrentUser = Depends(get_current_user)):
    """Permanent delete. A ticket from the website takes its online order
    (proof image, deposit) with it."""
    from app.routers.digital_menu import erase_digital_order_core  # digital_menu imports this module

    supabase = get_supabase()
    transaction = _override_target(supabase, transaction_id, user, body)
    linked = (supabase.table("digital_orders").select("id").eq("transaction_id", transaction_id)
              .limit(1).execute().data)
    if linked:
        erase_digital_order_core(supabase, linked[0]["id"], user, body.reason)
    else:
        erase_transaction_core(supabase, transaction_id, user, body.reason)
    _log_override("erase", transaction, user, body.reason)
    return {"id": transaction_id, "erased": True}


@router.patch("/transactions/{transaction_id}/advance-override/schedule", response_model=TransactionResponse)
def override_reschedule_advance(transaction_id: str, body: AdvanceOverrideScheduleRequest,
                                user: CurrentUser = Depends(get_current_user)):
    """Change the ready time at any stage, to any time. The kitchen status
    stays; the revision bump prints an updated ticket."""
    supabase = get_supabase()
    transaction = _override_target(supabase, transaction_id, user, body)
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="This order was voided")
    if (transaction.get("advance_schedule_revision") or 0) != body.expected_revision:
        raise HTTPException(status_code=409, detail="Order changed; refresh and try again")
    if body.scheduled_for.tzinfo is None or body.scheduled_for.utcoffset() is None:
        raise HTTPException(status_code=400, detail="Advance time must include a timezone")
    _bump_revision(supabase, transaction, user, {"scheduled_for": body.scheduled_for.astimezone(timezone.utc).isoformat()},
                   reprint=True)
    _log_override("reschedule", transaction, user, body.reason)
    return get_transaction(transaction_id, user)


@router.patch("/transactions/{transaction_id}/advance-override/customer", response_model=TransactionResponse)
def override_advance_customer(transaction_id: str, body: AdvanceOverrideCustomerRequest,
                              user: CurrentUser = Depends(get_current_user)):
    """Fix the customer's name, phone and (for a delivery) address."""
    supabase = get_supabase()
    transaction = _override_target(supabase, transaction_id, user, body)
    name, phone = body.name.strip(), body.phone.strip()
    if not name or len(re.sub(r"\D", "", phone)) < 7:
        raise HTTPException(status_code=400, detail="Enter the customer's name and a valid phone number")
    if transaction.get("order_type") == "delivery":
        delivery = delivery_row_for_transaction(supabase, transaction_id)
        if not delivery:
            raise HTTPException(status_code=404, detail="This order's delivery details were not found")
        patch = {"customer_name": name, "customer_phone": phone}
        for field in ("address", "barangay", "landmark"):
            value = getattr(body, field)
            if value is not None:
                patch[field] = value.strip() or None
        _bump_revision(supabase, transaction, user, reprint=True)
        supabase.table("deliveries").update(patch).eq("id", delivery["id"]).execute()
    else:
        _bump_revision(supabase, transaction, user, {"pickup_customer_name": name, "pickup_customer_phone": phone},
                       reprint=True)
    _log_override("customer", transaction, user, body.reason)
    return get_transaction(transaction_id, user)


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


@router.post("/tables/{pos_table_number}/release")
def release_table(pos_table_number: int, user: CurrentUser = Depends(get_current_user)):
    """Floor Plan's "Release table": closes every open dine-in order on the
    table from today (add-ons and QR orders included), which also moves
    their kitchen tickets to completed. Payment is not touched."""
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="Only front-of-house staff can release tables")
    supabase = get_supabase()
    start, end = ph_day_bounds_utc(today_ph())
    rows = (supabase.table("transactions").select("id, order_number")
            .eq("status", "open").eq("order_type", "dine_in").eq("table_number", pos_table_number)
            .gte("opened_at", start).lte("opened_at", end).order("opened_at").execute().data or [])
    released = []
    for row in rows:
        try:
            close_transaction(row["id"], user)
        except HTTPException as exc:
            if exc.status_code != 409:  # 409: closed meanwhile by another terminal
                raise
            continue
        released.append(row["order_number"])
    return {"released": len(released), "order_numbers": released}


@router.patch("/transactions/{transaction_id}/rider-payout")
def update_rider_payout(
    transaction_id: str,
    body: RiderPayoutUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="You cannot edit delivery payout")
    db = get_supabase()
    tx = (db.table("transactions").select("id,order_type,status")
          .eq("id", transaction_id).maybe_single().execute())
    if not tx or not tx.data:
        raise HTTPException(status_code=404, detail="Order not found")
    if tx.data["order_type"] != "delivery" or tx.data["status"] == "voided":
        raise HTTPException(status_code=400, detail="Only active delivery orders can have a rider payout")
    delivery = delivery_row_for_transaction(db, transaction_id)
    if not delivery:
        raise HTTPException(status_code=404, detail="Delivery details not found")
    updated = (db.table("deliveries").update({"rider_payout": round(body.rider_payout, 2)})
               .eq("id", delivery["id"]).execute())
    return updated.data[0]


@router.post("/transactions/{transaction_id}/settle-payment", response_model=TransactionResponse)
def settle_payment(transaction_id: str, body: SettlePaymentRequest, user: CurrentUser = Depends(get_current_user)):
    """Record payment for a deferred pickup or delivery sale. Any front-of-house
    staff can receive it, not just the cashier who entered the order."""
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="Only front-of-house staff can receive payments")
    supabase = get_supabase()
    if not _payment_status_supported_check(supabase):
        raise HTTPException(status_code=501, detail="Pay on delivery needs database migration 0062")
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="This order was voided")
    if transaction.get("payment_status") != "unpaid":
        raise HTTPException(status_code=409, detail="This order is already paid")
    _validate_grab_settlement(transaction.get("order_source") or "pos", body.payment_method)
    if body.payment_method == "card" and not body.card_type:
        raise HTTPException(status_code=400, detail="Select debit or credit")
    if body.payment_method != "card" and body.card_type:
        raise HTTPException(status_code=400, detail="Card type requires card payment")
    settled = supabase.table("transactions").update(
        {
            "payment_status": "paid",
            "paid_at": datetime.now(timezone.utc).isoformat(),
            "paid_by": user.id,
            "payment_method": body.payment_method,
            "card_type": body.card_type,
        }
    ).eq("id", transaction_id).eq("payment_status", "unpaid").neq("status", "voided").execute()
    if not settled.data:
        raise HTTPException(status_code=409, detail="Order is already paid or voided")
    refreshed = _fetch_transaction_with_items(supabase, transaction_id)
    items = refreshed.pop("items")
    return TransactionResponse(**refreshed, items=items)


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

    day_start, day_end = ph_day_bounds_utc(today_ph())
    other_open = (
        supabase.table("transactions")
        .select("id")
        .eq("table_number", body.new_table_number)
        .eq("status", "open")
        .eq("order_type", "dine_in")
        .gte("opened_at", day_start)
        .lte("opened_at", day_end)
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


def _restore_items_stock(supabase, transaction: dict, actor_id: str) -> None:
    """Gives back the stock a sale's items (transaction["items"]) took,
    including kitchen-fulfilled bundle rolls, plus its once-per-order stock
    items. Used by void and by the advance-order item edit."""
    transaction_id = transaction["id"]
    size_ids = [row["product_size_id"] for row in transaction["items"]]
    sizes_result = (
        supabase.table("product_sizes").select("id, products(is_bundle)").in_("id", size_ids).execute()
        if size_ids
        else None
    )
    is_bundle_by_size = {s["id"]: s["products"]["is_bundle"] for s in (sizes_result.data if sizes_result else [])}

    bundle_supported = _bundle_fulfillments_supported_check(supabase)
    atomic = bundle_supported and atomic_bundles_available(supabase)
    bundle_ids = [r["id"] for r in transaction["items"] if is_bundle_by_size.get(r["product_size_id"])]
    batches = (supabase.table("bundle_fulfillment_batches").select("transaction_item_id")
               .in_("transaction_item_id", bundle_ids).execute().data) if atomic and bundle_ids else []
    batch_ids = {r["transaction_item_id"] for r in batches}
    legacy_rows = (supabase.table("bundle_fulfillments").select("*")
                   .in_("transaction_item_id", bundle_ids).execute().data) if bundle_supported and bundle_ids else []
    legacy_rows = [r for r in legacy_rows if r["transaction_item_id"] not in batch_ids]
    # Resolve ALL historical rows before touching any stock on this order.
    legacy_sizes = legacy_recipe_sizes(supabase, legacy_rows)

    for row in transaction["items"]:
        if is_bundle_by_size.get(row["product_size_id"]):
            if not bundle_supported:
                continue
            if atomic and bundle_rpc(supabase, "restore_bundle_atomic", {
                    "p_transaction_id": transaction_id, "p_item_id": row["id"], "p_employee_id": actor_id,
                }):
                continue
            fulfillments = [f for f in legacy_rows if f["transaction_item_id"] == row["id"]]
            for f in fulfillments:
                _adjust_ingredients_for_size(
                    supabase, legacy_sizes[f["maki_roll_product_id"]], f["quantity"], sign=1,
                    employee_id=actor_id, transaction_id=transaction_id,
                )
            if fulfillments:
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
    # Mark it voided first, and only if it isn't already: two voids at the
    # same moment would otherwise both give the stock back.
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
        .neq("status", "voided")
        .execute()
    )
    if not updated.data:
        raise HTTPException(status_code=409, detail="This order was already voided")
    _restore_items_stock(supabase, transaction, actor_id)
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
    if user.role == "kitchen":
        raise HTTPException(status_code=403, detail="Kitchen accounts can't void orders")
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


class EraseTransactionRequest(BaseModel):
    override_key: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=500)


@router.post("/transactions/{transaction_id}/erase")
def erase_transaction(
    transaction_id: str,
    body: EraseTransactionRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Executive-only permanent erase, guarded by the caller's own override
    key (0076). Stock is returned first (unless a void already returned it),
    then erase_transaction deletes the order and everything hanging off it.
    Orders with a refund or cash-refund payout are refused by the database.
    Nothing is kept in the database; the server log keeps one line."""
    require_role(user, "executive")
    if not verify_override_key(user, body.override_key):
        raise HTTPException(status_code=403, detail="Override key is wrong, or you haven't set one yet (Settings)")
    return erase_transaction_core(get_supabase(), transaction_id, user, body.reason)


def erase_transaction_core(supabase, transaction_id: str, user: CurrentUser, reason: str) -> dict:
    """The erase itself, once the caller has checked role and override key.
    Also used by the online-order erase (digital_menu.py)."""
    transaction = _fetch_transaction_with_items(supabase, transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    blockers = (supabase.table("refunds").select("id").eq("transaction_id", transaction_id).limit(1).execute().data
                or supabase.table("shift_cash_movements").select("id").eq("transaction_id", transaction_id)
                .limit(1).execute().data)
    if blockers:
        raise HTTPException(status_code=409, detail="This order has a refund record, so it can't be erased")
    if transaction["status"] != "voided":
        _restore_items_stock(supabase, transaction, user.id)
    try:
        supabase.rpc("erase_transaction", {"p_id": transaction_id}).execute()
    except APIError as exc:
        raise HTTPException(status_code=409, detail=getattr(exc, "message", None) or "Could not erase this order") from exc
    logger.warning("Order erased: #%s (%s) total %s by %s (%s). Reason: %s",
                   transaction.get("order_number"), transaction_id, transaction.get("total_amount"),
                   user.full_name, user.id, reason)
    return {"id": transaction_id, "erased": True}


def _set_kitchen_status(supabase, transaction: dict, new_status: str, user: CurrentUser, allow_skip: bool) -> dict:
    # Any signed-in staff may move an order through the kitchen workflow --
    # whoever is at the kitchen tablet accepts/readies orders rung up by any
    # cashier. Ownership checks stay on money actions (void, refund).
    if transaction["status"] == "voided":
        raise HTTPException(status_code=400, detail="Cannot update a voided order")

    current = transaction.get("kitchen_status", "queued")
    if current == "queued" and new_status != "queued" and transaction.get("scheduled_for"):
        due = datetime.fromisoformat(transaction["scheduled_for"].replace("Z", "+00:00"))
        if due > datetime.now(timezone.utc) + ADVANCE_LEAD:
            raise HTTPException(status_code=409, detail="Advance order is still upcoming")
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


@router.post("/transactions/{transaction_id}/kitchen-reprint")
def request_kitchen_reprint(transaction_id: str, user: CurrentUser = Depends(get_current_user)):
    """Online Orders' "Print kitchen ticket": only the kitchen tablet is
    paired with the kitchen printer, so this just stamps the request and the
    tablet prints a REPRINT copy on its next Kitchen Display poll. Kitchen
    status is left alone. Front-of-house and kitchen roles only."""
    require_role(user, "employee", "manager", "executive", "kitchen")
    supabase = get_supabase()
    if not _kitchen_reprint_supported_check(supabase):
        raise HTTPException(status_code=501, detail="Kitchen ticket reprint needs database migration 0081")
    rows = supabase.table("transactions").select("id, status").eq("id", transaction_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if rows[0]["status"] == "voided":
        raise HTTPException(status_code=400, detail="This order was voided")
    requested_at = datetime.now(timezone.utc).isoformat()
    supabase.table("transactions").update({"kitchen_reprint_requested_at": requested_at}).eq("id", transaction_id).execute()
    return {"id": transaction_id, "kitchen_reprint_requested_at": requested_at}


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
    """Keep the existing tablet request contract; resolve and commit in one RPC."""
    return bundle_rpc(get_supabase(), "fulfill_bundle_with_pending_atomic" if body.allow_pending_recipe else "fulfill_bundle_atomic", {
        "p_transaction_id": transaction_id,
        "p_item_id": item_id,
        "p_employee_id": user.id,
        "p_lines": [line.model_dump() for line in body.lines],
    })
