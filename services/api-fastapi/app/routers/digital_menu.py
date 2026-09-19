"""Digital menu (QR table ordering).

A customer scans a per-table QR code, browses the menu, and submits an
order with no login -- there's no Supabase session on this device, same
situation as kiosk.py's Staff Clock, and the same fix applies: the
`/public/*` endpoints below take no `Depends(get_current_user)` at all,
authorize nothing beyond "does this request make sense" (never trust a
client-sent price; only ever look up an order by its own unguessable id,
never by the sequential order_number), and write via the shared
service-role `get_supabase()` client like every other router.

A digital_orders row is a staging area, not a sale -- see
transactions.py's `_create_transaction_row` for how an approved one
becomes a real transaction, through the exact same insert/deduction path
a POS sale uses. Add-ons (menu_addons/digital_order_addons) and held
ingredients (digital_order_items.held_ingredients) are digital-menu-only
concepts, not wired into recipe/ingredient deduction -- see migration
0017's header comment for why.
"""

import uuid
from datetime import datetime, timedelta, timezone

from cachetools import TTLCache
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc, today_ph
from app.idempotency import check_idempotency_key, record_idempotency_key
from app.rate_limit import client_ip, enforce_rate_limit
from app.routers.business_days import is_open_today
from app.routers.products import _list_products_data
from app.routers.recipes import _get_recipe_data
from app.routers.transactions import _create_transaction_row, _get_vat_rate
from app.schemas import (
    CreateDigitalOrderRequest,
    DeliveryFeeOut,
    DigitalOrderResponse,
    DigitalOrderStatusResponse,
    QueueDisplayOut,
    MenuAddonOut,
    ProductOut,
    RecipeItemOut,
    RejectDigitalOrderRequest,
    TransactionItemCreate,
)

router = APIRouter(tags=["digital-menu"])


def _fetch_digital_order(supabase, order_id: str) -> dict | None:
    result = supabase.table("digital_orders").select("*").eq("id", order_id).maybe_single().execute()
    if not result or not result.data:
        return None
    order = result.data
    items_result = supabase.table("digital_order_items").select("*").eq("digital_order_id", order_id).execute()
    order["items"] = items_result.data

    addons_result = (
        supabase.table("digital_order_addons")
        .select("*, menu_addons(name)")
        .eq("digital_order_id", order_id)
        .execute()
    )
    addons = []
    for row in addons_result.data:
        addon_info = row.pop("menu_addons", None) or {}
        row["addon_name"] = addon_info.get("name")
        addons.append(row)
    order["addons"] = addons

    if order.get("order_channel") != "dine_in_qr":
        delivery_result = (
            supabase.table("deliveries")
            .select("*, profiles(full_name)")
            .eq("digital_order_id", order_id)
            .maybe_single()
            .execute()
        )
        delivery = delivery_result.data if delivery_result else None
        if delivery:
            rider = delivery.pop("profiles", None) or {}
            delivery["rider_name"] = rider.get("full_name")
        order["delivery"] = delivery
    else:
        order["delivery"] = None
    return order


# ---------------------------------------------------------------------------
# Public (unauthenticated) -- the customer's own device
# ---------------------------------------------------------------------------


@router.get("/public/menu", response_model=list[ProductOut])
def public_menu():
    return _list_products_data(get_supabase(), active_only=True, department=None)


@router.get("/public/addons", response_model=list[MenuAddonOut])
def public_addons():
    result = get_supabase().table("menu_addons").select("*").eq("active", True).order("name").execute()
    return result.data


@router.get("/public/product-sizes/{product_size_id}/recipe", response_model=list[RecipeItemOut])
def public_recipe(product_size_id: str):
    return _get_recipe_data(get_supabase(), product_size_id)


@router.get("/public/delivery-fees", response_model=list[DeliveryFeeOut])
def public_delivery_fees():
    """The barangay dropdown + fee lookup for the general delivery/pickup
    link (apps/customer-menu with no ?table= param)."""
    result = get_supabase().table("delivery_fees").select("barangay, zone, fee").order("barangay").execute()
    return result.data


# The restaurant TV polls this every few seconds and several screens may
# share one backend instance -- a short cache keeps that from multiplying DB reads.
_queue_display_cache: TTLCache = TTLCache(maxsize=1, ttl=3)


@router.get("/public/queue-display", response_model=QueueDisplayOut)
def public_queue_display(request: Request):
    """Read-only feed for the in-restaurant "Now Serving" TV (/tv on the
    customer-menu app). Deliberately exposes nothing but today's order
    numbers grouped by kitchen stage -- no names, phones, items or ids -- so
    it's safe to leave unauthenticated."""
    if "v" in _queue_display_cache:
        return _queue_display_cache["v"]
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"queue-display:{client_ip(request)}", window_seconds=60, limit=120)
    start, end = ph_day_bounds_utc(today_ph())
    rows = (
        supabase.table("transactions")
        .select("order_number, kitchen_status, kitchen_status_updated_at, opened_at")
        .gte("opened_at", start)
        .lt("opened_at", end)
        .neq("status", "voided")
        .in_("kitchen_status", ["queued", "preparing", "ready"])
        .execute()
    ).data
    preparing = sorted(r["order_number"] for r in rows if r["kitchen_status"] in ("queued", "preparing") and r["order_number"] is not None)
    ready_rows = [r for r in rows if r["kitchen_status"] == "ready" and r["order_number"] is not None]
    # Most recently readied first, capped so an un-cleared backlog can't overflow the screen.
    ready_rows.sort(key=lambda r: r["kitchen_status_updated_at"] or r["opened_at"], reverse=True)
    result = {"preparing": preparing, "ready": [r["order_number"] for r in ready_rows[:12]]}
    _queue_display_cache["v"] = result
    return result


@router.post("/public/orders", response_model=DigitalOrderStatusResponse)
def submit_digital_order(body: CreateDigitalOrderRequest, request: Request):
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"order-submit:{client_ip(request)}", window_seconds=60, limit=20)
    existing_id = check_idempotency_key(supabase, body.idempotency_key, "POST /public/orders")
    if existing_id:
        return _fetch_digital_order(supabase, existing_id)

    if not body.items:
        raise HTTPException(status_code=400, detail="Order must have at least one item")

    # Backstop for a stale customer-menu page/cart built before the cashier
    # closed (or before they've opened) today's business day -- the
    # frontend gates this at "press an item," this just makes sure it
    # can't be bypassed by an already-open tab.
    # An advance order is for later, so it's allowed while today's business
    # day is closed/unopened -- staff decide when to approve it.
    scheduled_for: datetime | None = None
    if body.scheduled_for is not None:
        if body.order_channel == "dine_in_qr":
            raise HTTPException(status_code=400, detail="Advance orders are only for delivery or pickup")
        scheduled_for = body.scheduled_for if body.scheduled_for.tzinfo else body.scheduled_for.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if scheduled_for < now + timedelta(minutes=30):
            raise HTTPException(status_code=400, detail="Advance orders must be scheduled at least 30 minutes ahead")
        if scheduled_for > now + timedelta(days=7):
            raise HTTPException(status_code=400, detail="Advance orders can be scheduled at most 7 days ahead")
    elif not is_open_today(supabase):
        raise HTTPException(status_code=403, detail="The shop is currently closed")

    delivery_fee: float | None = None
    if body.order_channel == "dine_in_qr":
        if not body.table_number:
            raise HTTPException(status_code=400, detail="Table number is required for a QR table order")
    else:
        if not body.customer_name or not body.customer_phone:
            raise HTTPException(status_code=400, detail="Name and phone number are required")
        if body.order_channel == "delivery":
            if not body.address or not body.barangay:
                raise HTTPException(status_code=400, detail="Address and barangay are required for delivery")
            fee_result = (
                supabase.table("delivery_fees")
                .select("fee")
                .eq("barangay", body.barangay)
                .maybe_single()
                .execute()
            )
            if not fee_result or not fee_result.data:
                raise HTTPException(status_code=400, detail=f"No delivery fee configured for {body.barangay}")
            delivery_fee = float(fee_result.data["fee"])

    # The online-payment/proof-of-payment feature is delivery/pickup only
    # (per spec) -- dine-in QR keeps its original, unchanged, waiter-
    # mediated cash/gcash choice, so it's never checked against the
    # admin-managed method list (which would otherwise reject the literal
    # "gcash" the moment no method happens to be named exactly that).
    if body.order_channel != "dine_in_qr" and body.payment_method != "cash":
        method_result = (
            supabase.table("online_payment_methods")
            .select("id")
            .eq("name", body.payment_method)
            .eq("active", True)
            .maybe_single()
            .execute()
        )
        if not method_result or not method_result.data:
            raise HTTPException(status_code=400, detail=f"Unknown payment method: {body.payment_method}")

    size_ids = [item.product_size_id for item in body.items]
    sizes_result = supabase.table("product_sizes").select("id, price").in_("id", size_ids).execute()
    sizes_by_id = {s["id"]: s for s in sizes_result.data}
    missing = [sid for sid in size_ids if sid not in sizes_by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"Product sizes not found: {missing}")

    addon_ids = [a.addon_id for a in body.addons]
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

    # Prices are always recomputed from the live catalog -- a client-sent
    # price is never trusted, same posture as create_transaction.
    subtotal = 0.0
    for item in body.items:
        unit_price = float(sizes_by_id[item.product_size_id]["price"])
        subtotal += unit_price * item.quantity
    for addon in body.addons:
        unit_price = float(addons_by_id[addon.addon_id]["price"])
        subtotal += unit_price * addon.quantity

    order_row = {
        "table_number": body.table_number,
        "order_channel": body.order_channel,
        "status": "pending",
        "payment_method": body.payment_method,
        "customer_note": body.customer_note,
        "subtotal": subtotal,
    }
    if scheduled_for is not None:
        # Only sent when set, so ordinary orders keep working even before
        # migration 0054 (digital_orders.scheduled_for) is applied.
        order_row["scheduled_for"] = scheduled_for.isoformat()
    order_insert = supabase.table("digital_orders").insert(order_row).execute()
    order = order_insert.data[0]

    if body.order_channel != "dine_in_qr":
        supabase.table("deliveries").insert(
            {
                "digital_order_id": order["id"],
                "customer_name": body.customer_name,
                "customer_phone": body.customer_phone,
                "address": body.address,
                "landmark": body.landmark,
                "barangay": body.barangay,
                "delivery_fee": delivery_fee,
            }
        ).execute()

    item_rows = [
        {
            "digital_order_id": order["id"],
            "product_size_id": item.product_size_id,
            "quantity": item.quantity,
            "unit_price": float(sizes_by_id[item.product_size_id]["price"]),
            "held_ingredients": item.held_ingredients,
        }
        for item in body.items
    ]
    supabase.table("digital_order_items").insert(item_rows).execute()

    if body.addons:
        addon_rows = [
            {
                "digital_order_id": order["id"],
                "addon_id": addon.addon_id,
                "quantity": addon.quantity,
                "unit_price": float(addons_by_id[addon.addon_id]["price"]),
            }
            for addon in body.addons
        ]
        supabase.table("digital_order_addons").insert(addon_rows).execute()

    record_idempotency_key(supabase, body.idempotency_key, "POST /public/orders", order["id"])
    return _fetch_digital_order(supabase, order["id"])


PROOF_STORAGE_BUCKET = "payment-proofs"
PROOF_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
PROOF_MAX_BYTES = 5 * 1024 * 1024


@router.post("/public/orders/{order_id}/proof-of-payment", response_model=DigitalOrderStatusResponse)
async def upload_proof_of_payment(order_id: str, file: UploadFile = File(...)):
    """Unauthenticated, same trust model as every other /public/* endpoint
    here -- the order's own unguessable id is the entire access control,
    identical posture to public_order_status above. Only allowed while
    still pending, so a decided order's record can't be tampered with
    after the fact."""
    supabase = get_supabase()
    order = _fetch_digital_order(supabase, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Order is already {order['status']} -- proof can no longer be attached")

    if file.content_type not in PROOF_ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or WEBP images are allowed")

    contents = await file.read()
    if len(contents) > PROOF_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 5MB or smaller")

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    storage_path = f"{order_id}/{uuid.uuid4()}.{ext}"

    supabase.storage.from_(PROOF_STORAGE_BUCKET).upload(
        storage_path, contents, file_options={"content-type": file.content_type}
    )
    public_url = supabase.storage.from_(PROOF_STORAGE_BUCKET).get_public_url(storage_path)

    supabase.table("digital_orders").update({"payment_proof_url": public_url}).eq("id", order_id).execute()
    return _fetch_digital_order(supabase, order_id)


@router.get("/public/orders/{order_id}", response_model=DigitalOrderStatusResponse)
def public_order_status(order_id: str):
    order = _fetch_digital_order(get_supabase(), order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


# ---------------------------------------------------------------------------
# Staff-facing (authenticated) -- the approval dashboard
# ---------------------------------------------------------------------------


@router.get("/digital-orders", response_model=list[DigitalOrderResponse])
def list_digital_orders(
    status: str | None = Query(None),
    limit: int = Query(200, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    supabase = get_supabase()
    query = supabase.table("digital_orders").select("*")
    if status:
        query = query.eq("status", status)
    orders = query.order("created_at", desc=True).limit(limit).execute().data
    if not orders:
        return []

    order_ids = [o["id"] for o in orders]
    items_result = supabase.table("digital_order_items").select("*").in_("digital_order_id", order_ids).execute()
    items_by_order: dict[str, list] = {}
    for item in items_result.data:
        items_by_order.setdefault(item["digital_order_id"], []).append(item)

    addons_result = (
        supabase.table("digital_order_addons")
        .select("*, menu_addons(name)")
        .in_("digital_order_id", order_ids)
        .execute()
    )
    addons_by_order: dict[str, list] = {}
    for row in addons_result.data:
        addon_info = row.pop("menu_addons", None) or {}
        row["addon_name"] = addon_info.get("name")
        addons_by_order.setdefault(row["digital_order_id"], []).append(row)

    delivery_order_ids = [o["id"] for o in orders if o.get("order_channel") != "dine_in_qr"]
    deliveries_by_order: dict[str, dict] = {}
    if delivery_order_ids:
        deliveries_result = (
            supabase.table("deliveries").select("*").in_("digital_order_id", delivery_order_ids).execute()
        )
        deliveries_by_order = {d["digital_order_id"]: d for d in deliveries_result.data}

    for order in orders:
        order["items"] = items_by_order.get(order["id"], [])
        order["addons"] = addons_by_order.get(order["id"], [])
        order["delivery"] = deliveries_by_order.get(order["id"])
    return orders


@router.post("/digital-orders/{order_id}/approve", response_model=DigitalOrderResponse)
def approve_digital_order(order_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    order = _fetch_digital_order(supabase, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Order is already {order['status']}")

    # transactions.payment_method keeps POS's fixed CHECK ('cash','gcash',
    # 'card') -- a digital order's payment_method is now any admin-managed
    # online method name (e.g. "Maya", "Maribank"), which that constraint
    # would reject outright. "cash" passes through as-is; anything else is
    # an online/e-wallet payment, recorded generically as "gcash" on the
    # transaction (POS reporting doesn't need the specific provider broken
    # out there) -- the actual method name and proof-of-payment image stay
    # on the digital_orders row itself as the real audit record.
    pos_payment_method = "cash" if order.get("payment_method") == "cash" else "gcash"

    transaction = _create_transaction_row(
        supabase,
        employee_id=user.id,
        items=[
            TransactionItemCreate(
                product_size_id=i["product_size_id"],
                quantity=i["quantity"],
                held_ingredients=i.get("held_ingredients", []),
            )
            for i in order["items"]
        ],
        payment_method=pos_payment_method,
        # Delivery/pickup orders are never dine-in -- label them takeout so
        # the kitchen ticket unambiguously reads as a to-go/carried-out order,
        # regardless of which of the two non-QR channels this came from.
        order_type="takeout" if order.get("order_channel") != "dine_in_qr" else None,
    )

    # Add-ons aren't real catalog products, so they were never part of
    # _create_transaction_row's items -- fold their (taxed) cost into the
    # transaction's totals now so the till reconciles correctly. Same for a
    # delivery's fee, which isn't a catalog item either. The digital_orders
    # row (linked via transaction_id) remains the record of exactly what was
    # ordered and, for delivery, what the fee was.
    delivery_fee = float(order["delivery"]["delivery_fee"]) if order.get("delivery") and order["delivery"].get("delivery_fee") else 0.0
    addons_subtotal = sum(float(a["unit_price"]) * a["quantity"] for a in order["addons"]) + delivery_fee
    if addons_subtotal:
        supabase.table("transactions").update(
            {
                "total_amount": transaction.total_amount + addons_subtotal,
                "tax_amount": transaction.tax_amount + addons_subtotal * _get_vat_rate(supabase),
            }
        ).eq("id", transaction.id).execute()

    updated = (
        supabase.table("digital_orders")
        .update(
            {
                "status": "approved",
                "approved_by": user.id,
                "approved_at": datetime.now(timezone.utc).isoformat(),
                "transaction_id": transaction.id,
            }
        )
        .eq("id", order_id)
        .execute()
    )
    result = updated.data[0]
    result["items"] = order["items"]
    result["addons"] = order["addons"]
    result["delivery"] = order.get("delivery")
    return result


@router.post("/digital-orders/{order_id}/reject", response_model=DigitalOrderResponse)
def reject_digital_order(
    order_id: str,
    body: RejectDigitalOrderRequest,
    user: CurrentUser = Depends(get_current_user),
):
    if not body.reason or not body.reason.strip():
        raise HTTPException(status_code=400, detail="A reason is required")

    supabase = get_supabase()
    order = _fetch_digital_order(supabase, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Order is already {order['status']}")

    updated = (
        supabase.table("digital_orders")
        .update({"status": "rejected", "rejected_reason": body.reason.strip()})
        .eq("id", order_id)
        .execute()
    )
    result = updated.data[0]
    result["items"] = order["items"]
    result["addons"] = order["addons"]
    result["delivery"] = order.get("delivery")
    return result
