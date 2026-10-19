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

import json
import time
import uuid
from datetime import datetime, timedelta, timezone

from cachetools import TTLCache
from pydantic import TypeAdapter
from postgrest.exceptions import APIError
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc, today_ph
from app.idempotency import check_idempotency_key, record_idempotency_key
from app.rate_limit import client_ip, enforce_rate_limit, local_rate_limit, public_cache
from app.routers.business_days import is_open_today
from app.routers.products import _list_products_data
from app.routers.recipes import _get_recipe_data
from app.routers.reservations import ADVANCE_ORDER_LEAD_MINUTES
from app.routers.transactions import (
    _create_transaction_row, _get_vat_rate, close_transaction, live_cache_get, live_cache_put,
    live_cache_version, settle_payment,
)
from app.schemas import (
    BoatDepositReturnRequest,
    CreateDigitalOrderRequest,
    DeliveryFeeOut,
    DigitalOrderResponse,
    DigitalOrderStatusResponse,
    FirstOrderPromoOut,
    QueueDisplayOut,
    MenuAddonOut,
    ProductOut,
    RecipeItemOut,
    RejectDigitalOrderRequest,
    SettlePaymentRequest,
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
    order["boat_deposits"] = (
        supabase.table("sushi_boat_deposits").select("*").eq("digital_order_id", order_id).execute().data
        if float(order.get("boat_deposit") or 0) > 0 else []
    )

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


# Public catalog reads are the busiest unauthenticated endpoints. Each is
# cached here and at Vercel's CDN (public_cache), so a burst of visitors costs
# one Supabase read per window instead of one per page view. The menu window
# is short because it carries sold-out state.
_public_cache: TTLCache = TTLCache(maxsize=8, ttl=30)
MENU_CACHE_SECONDS = 30
CATALOG_CACHE_SECONDS = 300

# The first-online-order free item only goes to an order whose items + add-ons
# reach this amount, so a small order can't use up the day's promo.
FIRST_ORDER_PROMO_MIN_SUBTOTAL = 499.0
FIRST_ORDER_PROMO_ITEM_NAME = "4 pcs Torikatsu Maki"


def _cached_public(key: str, build):
    if key not in _public_cache:
        _public_cache[key] = build()
    return _public_cache[key]


# POS-only categories: cash-register line items, not customer-facing dishes.
# "Packaging" is sold containers; "Dine" is in-store services (the ₱100 Photo).
POS_ONLY_CATEGORIES = {"packaging", "dine"}


@router.get("/public/menu", response_model=list[ProductOut])
def public_menu(response: Response):
    # Keep the shared product catalog for the POS but hide POS-only items
    # from the online ordering menu and the website.
    public_cache(response, MENU_CACHE_SECONDS)
    return _cached_public("menu", lambda: [
        product for product in _list_products_data(get_supabase(), active_only=True, department=None)
        if product["category"].strip().casefold() not in POS_ONLY_CATEGORIES
    ])


@router.get("/public/addons", response_model=list[MenuAddonOut])
def public_addons(response: Response):
    public_cache(response, MENU_CACHE_SECONDS)
    return _cached_public("addons", lambda: get_supabase().table("menu_addons").select("*")
                          .eq("active", True).order("name").execute().data)


@router.get("/public/promo/first-order", response_model=FirstOrderPromoOut)
def public_first_order_promo(response: Response):
    """Whether today's first-online-order promo is still up for grabs, for the
    cart's "add ₱X more" notice. Only a hint: the claim is decided at submit."""
    public_cache(response, MENU_CACHE_SECONDS)

    def build():
        supabase = get_supabase()
        available = False
        if _promo_size_id(supabase):
            try:
                claimed = (supabase.table("online_promo_claims").select("promo_date")
                           .eq("promo_date", today_ph().isoformat()).limit(1).execute().data)
                available = not claimed
            except APIError:
                available = False  # migration 0078 not applied yet
        return {"available": available, "min_subtotal": FIRST_ORDER_PROMO_MIN_SUBTOTAL,
                "item_name": FIRST_ORDER_PROMO_ITEM_NAME}

    return _cached_public("first-order-promo", build)


@router.get("/public/product-sizes/{product_size_id}/recipe", response_model=list[RecipeItemOut])
def public_recipe(product_size_id: str):
    return _get_recipe_data(get_supabase(), product_size_id)


@router.get("/public/delivery-fees", response_model=list[DeliveryFeeOut])
def public_delivery_fees(response: Response):
    """The barangay/town dropdown + fee lookup for the general delivery/pickup
    link (apps/customer-menu with no ?table= param). Grouped by zone."""
    public_cache(response, CATALOG_CACHE_SECONDS)
    return _cached_public("delivery-fees", lambda: get_supabase().table("delivery_fees")
                          .select("barangay, zone, fee").order("zone").order("barangay").execute().data)


# The restaurant TV polls this every few seconds and several screens may
# share one backend instance -- a short cache keeps that from multiplying DB reads.
_queue_display_cache: TTLCache = TTLCache(maxsize=1, ttl=2)


@router.get("/public/queue-display", response_model=QueueDisplayOut)
def public_queue_display(request: Request):
    """Read-only feed for the in-restaurant "Now Serving" TV (/tv on the
    customer-menu app). Deliberately exposes nothing but today's order
    numbers grouped by kitchen stage -- no names, phones, items or ids -- so
    it's safe to leave unauthenticated. POS-originated orders only, and the
    two lists mirror Kitchen Display's own columns: `preparing` is exactly the
    Preparing column (queued tickets are not shown yet) and `ready` is exactly
    the Ready column -- a ticket only moves to "Now Serving" when kitchen
    staff move it there."""
    if "v" in _queue_display_cache:
        return _queue_display_cache["v"]
    # Rebuilt only when orders change (live_version), not on every TV poll.
    body = live_cache_get(("queue-display",))
    if body is not None:
        return Response(body, media_type="application/json")
    version = live_cache_version()
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"queue-display:{client_ip(request)}", window_seconds=60, limit=120)
    start, end = ph_day_bounds_utc(today_ph())
    rows = (
        supabase.table("transactions")
        .select("id, order_number, kitchen_status, kitchen_status_updated_at, opened_at")
        .gte("opened_at", start)
        .lt("opened_at", end)
        .neq("status", "voided")
        .in_("kitchen_status", ["queued", "preparing", "ready"])
        .execute()
    ).data
    # The TV board is for orders rung up at the POS counter only. Approved
    # online/QR orders become transactions too, but they're linked back from
    # digital_orders.transaction_id, so drop those.
    ids = [r["id"] for r in rows]
    from_digital: set[str] = set()
    for i in range(0, len(ids), 200):
        linked = supabase.table("digital_orders").select("transaction_id").in_("transaction_id", ids[i : i + 200]).execute()
        from_digital.update(d["transaction_id"] for d in linked.data)
    rows = [r for r in rows if r["id"] not in from_digital]
    preparing = sorted(r["order_number"] for r in rows if r["kitchen_status"] == "preparing" and r["order_number"] is not None)
    ready_rows = [r for r in rows if r["kitchen_status"] == "ready" and r["order_number"] is not None]
    # Most recently readied first, capped so an un-cleared backlog can't overflow the screen.
    ready_rows.sort(key=lambda r: r["kitchen_status_updated_at"] or r["opened_at"], reverse=True)
    result = {"preparing": preparing, "ready": [r["order_number"] for r in ready_rows[:12]]}
    _queue_display_cache["v"] = result
    live_cache_put(("queue-display",), json.dumps(result).encode(), version)
    return result


@router.post("/public/orders", response_model=DigitalOrderStatusResponse)
def submit_digital_order(body: CreateDigitalOrderRequest, request: Request):
    local_rate_limit(f"order-submit:{client_ip(request)}", limit=10, window_seconds=60)
    if body.website:
        # Honeypot filled in: a bot. Nothing is saved.
        raise HTTPException(status_code=400, detail="Could not place this order. Please refresh the page and try again.")
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
        # A table QR is just a URL, so an old/mistyped code or a hand-edited
        # ?table=99 must not create an order for a table that doesn't exist.
        known_table = (
            supabase.table("tables")
            .select("id")
            .eq("pos_table_number", body.table_number)
            .eq("active", True)
            .limit(1)
            .execute()
        )
        if not known_table.data:
            raise HTTPException(
                status_code=400,
                detail=f"Table {body.table_number} isn't one of our tables -- please ask a staff member for help",
            )
    else:
        if not body.customer_name or not body.customer_phone:
            raise HTTPException(status_code=400, detail="Name and phone number are required")
        _limit_pending_per_phone(supabase, body.customer_phone)
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
    sizes_result = supabase.table("product_sizes").select("id, price, deposit_amount, products(name, category, department, takeout_bowl_eligible)").in_("id", size_ids).execute()
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
    packaging_fee = 0.0
    boat_deposit = 0.0
    for item in body.items:
        size = sizes_by_id[item.product_size_id]
        unit_price = float(size["price"])
        subtotal += unit_price * item.quantity
        product = size.get("products") or {}
        if body.order_channel != "dine_in_qr":
            if product.get("takeout_bowl_eligible"):
                if not float(item.quantity).is_integer():
                    raise HTTPException(status_code=400, detail="Food quantities must be whole numbers for takeout packaging")
                packaging_fee += 10 * item.quantity
            deposit_per_unit = float(size.get("deposit_amount") or 0)
            if deposit_per_unit:
                if not float(item.quantity).is_integer():
                    raise HTTPException(status_code=400, detail="Sushi Boat quantities must be whole numbers")
                boat_deposit += deposit_per_unit * item.quantity
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
        "packaging_fee": packaging_fee,
        "boat_deposit": boat_deposit,
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
    inserted_items = supabase.table("digital_order_items").insert(item_rows).execute().data
    deposit_rows = []
    for item, saved_item in zip(body.items, inserted_items):
        deposit_per_unit = float(sizes_by_id[item.product_size_id].get("deposit_amount") or 0)
        if deposit_per_unit and body.order_channel != "dine_in_qr":
            for unit_number in range(1, int(item.quantity) + 1):
                deposit_rows.append({
                    "digital_order_id": order["id"],
                    "digital_order_item_id": saved_item["id"],
                    "product_size_id": item.product_size_id,
                    "unit_number": unit_number,
                    "amount": deposit_per_unit,
                })
    if deposit_rows:
        supabase.table("sushi_boat_deposits").insert(deposit_rows).execute()

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

    if body.order_channel != "dine_in_qr":
        _claim_first_order_promo(supabase, order["id"], subtotal)

    record_idempotency_key(supabase, body.idempotency_key, "POST /public/orders", order["id"])
    return _fetch_digital_order(supabase, order["id"])


MAX_PENDING_ORDERS_PER_PHONE = 3


def _limit_pending_per_phone(supabase, phone: str) -> None:
    """A real customer rarely has more than one order waiting; this stops a
    script from filling the cashier's queue with one phone number."""
    linked = (supabase.table("deliveries").select("digital_order_id").eq("customer_phone", phone)
              .not_.is_("digital_order_id", "null").order("id", desc=True).limit(50).execute().data)
    ids = [row["digital_order_id"] for row in linked]
    if not ids:
        return
    pending = (supabase.table("digital_orders").select("id").in_("id", ids)
               .eq("status", "pending").execute().data)
    if len(pending) >= MAX_PENDING_ORDERS_PER_PHONE:
        raise HTTPException(status_code=409, detail="You already have orders waiting for confirmation. Please wait for the shop to confirm them.")


def _promo_size_id(supabase) -> str | None:
    try:
        row = (supabase.table("business_settings").select("first_order_promo_size_id")
               .eq("id", 1).maybe_single().execute())
    except APIError:
        return None  # migration 0078 not applied yet
    return (row.data or {}).get("first_order_promo_size_id") if row else None


def _claim_first_order_promo(supabase, order_id: str, subtotal: float) -> bool:
    """First delivery/pickup order of the PH day reaching the minimum
    subtotal gets the promo item free. The claim table's primary key on the
    date makes "first" atomic; a declined order releases its claim (see
    reject_digital_order)."""
    if subtotal < FIRST_ORDER_PROMO_MIN_SUBTOTAL:
        return False
    size_id = _promo_size_id(supabase)
    if not size_id:
        return False
    try:
        won = (supabase.table("online_promo_claims")
               .upsert({"promo_date": today_ph().isoformat(), "digital_order_id": order_id},
                       on_conflict="promo_date", ignore_duplicates=True)
               .execute().data)
    except APIError:
        return False
    if not won:
        return False
    supabase.table("digital_order_items").insert({
        "digital_order_id": order_id, "product_size_id": size_id, "quantity": 1,
        "unit_price": 0, "held_ingredients": [], "is_promo": True,
    }).execute()
    return True


PROOF_STORAGE_BUCKET = "payment-proofs"
PROOF_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
PROOF_MAX_BYTES = 5 * 1024 * 1024


@router.post("/public/orders/{order_id}/proof-of-payment", response_model=DigitalOrderStatusResponse)
async def upload_proof_of_payment(order_id: str, request: Request, file: UploadFile = File(...)):
    """Unauthenticated, same trust model as every other /public/* endpoint
    here -- the order's own unguessable id is the entire access control,
    identical posture to public_order_status above. Only allowed while
    still pending, so a decided order's record can't be tampered with
    after the fact."""
    local_rate_limit(f"proof-upload:{client_ip(request)}", limit=10, window_seconds=600)
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
def public_order_status(order_id: str, request: Request):
    # The customer's page polls this every 10 s while pending.
    local_rate_limit(f"order-status:{client_ip(request)}", limit=30, window_seconds=60)
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
    # Polled by every cashier screen's new-order alarm and the kitchen tablet;
    # shares transactions.py's live cache (rebuilt only when orders change).
    cache_key = ("digital-orders", status, limit)
    body = live_cache_get(cache_key)
    if body is not None:
        return Response(body, media_type="application/json")
    version = live_cache_version()
    return live_cache_put(cache_key, _digital_orders_json.dump_json(
        _digital_orders_json.validate_python(_list_digital_orders(status, limit))), version)


_digital_orders_json = TypeAdapter(list[DigitalOrderResponse])


BOARD_STAGES = ("pending", "in_queue", "out_for_delivery", "completed")


def board_stage(order: dict, tx: dict | None) -> str | None:
    """Where an online order is, for the cashier's Online tab. None = hidden
    (declined, or a voided order)."""
    if order["status"] == "pending":
        return "pending"
    if order["status"] != "approved":
        return None
    if tx is None:
        return "in_queue"  # approved advance order, not in the kitchen yet
    if tx.get("status") == "voided":
        return None
    if tx.get("status") == "closed":
        return "completed"
    paid = tx.get("payment_status") != "unpaid"
    if order.get("order_channel") == "delivery":
        if (order.get("delivery") or {}).get("delivered_at"):
            return "completed" if paid else "out_for_delivery"
        return "out_for_delivery" if tx.get("kitchen_status") == "completed" else "in_queue"
    # Pickup: ready at the counter shares the "out" column until it's paid for.
    if tx.get("kitchen_status") in ("ready", "completed"):
        return "completed" if paid and tx.get("kitchen_status") == "completed" else "out_for_delivery"
    return "in_queue"


def _require_front_of_house(user: CurrentUser) -> None:
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="Front-of-house staff only")


@router.get("/digital-orders/board")
def digital_orders_board(user: CurrentUser = Depends(get_current_user)):
    """The cashier's Online orders tab: today's website delivery/pickup orders
    (plus anything still pending, or scheduled for today), each with its stage."""
    _require_front_of_house(user)
    cache_key = ("digital-board", today_ph().isoformat())
    body = live_cache_get(cache_key)
    if body is not None:
        return Response(body, media_type="application/json")
    version = live_cache_version()
    supabase = get_supabase()
    start, _ = ph_day_bounds_utc(today_ph())
    orders = (supabase.table("digital_orders").select("*")
              .in_("order_channel", ["delivery", "pickup"])
              .or_(f"created_at.gte.{start},status.eq.pending,scheduled_for.gte.{start}")
              .order("created_at", desc=True).limit(300).execute().data)
    orders = _hydrate_digital_orders(supabase, orders)
    tx_ids = [o["transaction_id"] for o in orders if o.get("transaction_id")]
    txs = {t["id"]: t for t in (supabase.table("transactions")
                                .select("id, order_number, status, kitchen_status, payment_status")
                                .in_("id", tx_ids).execute().data if tx_ids else [])}
    board = []
    for order in orders:
        tx = txs.get(order.get("transaction_id"))
        stage = board_stage(order, tx)
        if stage is None:
            continue
        order["stage"] = stage
        order["kitchen_status"] = (tx or {}).get("kitchen_status")
        order["pos_order_number"] = (tx or {}).get("order_number")
        order["payment_status"] = (tx or {}).get("payment_status")
        board.append(order)
    return live_cache_put(cache_key, _board_json.dump_json(_board_json.validate_python(board)), version)


_board_json = TypeAdapter(list[DigitalOrderResponse])


@router.post("/digital-orders/{order_id}/delivered")
def mark_digital_order_delivered(order_id: str, user: CurrentUser = Depends(get_current_user)):
    """Cashier confirms an online delivery reached the customer."""
    _require_front_of_house(user)
    supabase = get_supabase()
    row = (supabase.table("deliveries").select("id, delivered_at")
           .eq("digital_order_id", order_id).limit(1).execute().data)
    if not row:
        raise HTTPException(status_code=404, detail="This order has no delivery")
    if row[0]["delivered_at"]:
        return {"id": order_id, "delivered_at": row[0]["delivered_at"]}
    now = datetime.now(timezone.utc).isoformat()
    supabase.table("deliveries").update({"delivered_at": now}).eq("id", row[0]["id"]).execute()
    return {"id": order_id, "delivered_at": now}


@router.post("/digital-orders/{order_id}/complete")
def complete_digital_order(order_id: str, user: CurrentUser = Depends(get_current_user)):
    """Cashier finishes an online order: logs the cash if it's still unpaid,
    marks a delivery delivered, and closes the ticket. Safe to repeat."""
    _require_front_of_house(user)
    supabase = get_supabase()
    order = (supabase.table("digital_orders").select("id, status, order_channel, transaction_id")
             .eq("id", order_id).maybe_single().execute())
    if not order or not order.data:
        raise HTTPException(status_code=404, detail="Online order not found")
    order = order.data
    if order["status"] != "approved" or not order.get("transaction_id"):
        raise HTTPException(status_code=409, detail="Approve this order and send it to the kitchen first")
    tx_id = order["transaction_id"]
    tx = (supabase.table("transactions").select("id, status, payment_status")
          .eq("id", tx_id).maybe_single().execute())
    if not tx or not tx.data:
        raise HTTPException(status_code=404, detail="This order's ticket was not found")
    if tx.data["status"] == "voided":
        raise HTTPException(status_code=409, detail="This order was voided")
    if tx.data.get("payment_status") == "unpaid":
        try:
            settle_payment(tx_id, SettlePaymentRequest(payment_method="cash"), user)
        except HTTPException as exc:
            if exc.status_code != 409:  # 409: paid meanwhile on another terminal
                raise
    if order["order_channel"] == "delivery":
        mark_digital_order_delivered(order_id, user)
    if tx.data["status"] == "open":
        try:
            close_transaction(tx_id, user)
        except HTTPException as exc:
            if exc.status_code != 409:  # 409: closed meanwhile
                raise
    return {"id": order_id, "stage": "completed"}


def _list_digital_orders(status: str | None, limit: int) -> list[dict]:
    supabase = get_supabase()
    query = supabase.table("digital_orders").select("*")
    if status:
        query = query.eq("status", status)
    orders = query.order("created_at", desc=True).limit(limit).execute().data
    return _hydrate_digital_orders(supabase, orders)


def _hydrate_digital_orders(supabase, orders: list[dict]) -> list[dict]:
    """Attach items, add-ons and the delivery row to digital_orders rows."""
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


def _require_deposit_staff(user: CurrentUser) -> None:
    if user.role not in {"employee", "manager", "executive"}:
        raise HTTPException(status_code=403, detail="Staff access is required")


@router.get("/sushi-boat-deposits")
def list_sushi_boat_deposits(user: CurrentUser = Depends(get_current_user)):
    """Staff ledger for online pickup/delivery Sushi Boat deposits."""
    _require_deposit_staff(user)
    supabase = get_supabase()
    rows = supabase.table("sushi_boat_deposits").select("*").order("created_at", desc=True).limit(500).execute().data
    if not rows:
        return []
    order_ids = list({row["digital_order_id"] for row in rows})
    item_ids = list({row["digital_order_item_id"] for row in rows})
    size_ids = list({row["product_size_id"] for row in rows})
    staff_ids = list({row[key] for row in rows for key in ("collected_by", "handed_by", "returned_by") if row.get(key)})
    orders = {row["id"]: row for row in supabase.table("digital_orders").select("id,order_number,order_channel,status,payment_method,scheduled_for,created_at").in_("id", order_ids).execute().data}
    deliveries = {row["digital_order_id"]: row for row in supabase.table("deliveries").select("digital_order_id,customer_name,customer_phone,address,barangay").in_("digital_order_id", order_ids).execute().data}
    items = {row["id"]: row for row in supabase.table("digital_order_items").select("id,quantity").in_("id", item_ids).execute().data}
    sizes = supabase.table("product_sizes").select("id,size_label,products(name)").in_("id", size_ids).execute().data
    sizes_by_id = {row["id"]: row for row in sizes}
    staff = {row["id"]: row.get("full_name") for row in supabase.table("profiles").select("id,full_name").in_("id", staff_ids).execute().data} if staff_ids else {}
    for row in rows:
        row["order"] = orders.get(row["digital_order_id"], {})
        row["delivery"] = deliveries.get(row["digital_order_id"])
        row["item_quantity"] = items.get(row["digital_order_item_id"], {}).get("quantity", 1)
        size = sizes_by_id.get(row["product_size_id"], {})
        product = size.get("products") or {}
        row["product_name"] = product.get("name", "Sushi Boat")
        row["size_label"] = size.get("size_label")
        row["collected_by_name"] = staff.get(row.get("collected_by"))
        row["handed_by_name"] = staff.get(row.get("handed_by"))
        row["returned_by_name"] = staff.get(row.get("returned_by"))
    return rows


@router.post("/sushi-boat-deposits/{deposit_id}/collect")
def collect_sushi_boat_deposit(deposit_id: str, user: CurrentUser = Depends(get_current_user)):
    _require_deposit_staff(user)
    supabase = get_supabase()
    row_result = supabase.table("sushi_boat_deposits").select("*").eq("id", deposit_id).maybe_single().execute()
    row = row_result.data if row_result else None
    if not row:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if row.get("collected_at"):
        raise HTTPException(status_code=409, detail="Deposit is already recorded as collected")
    order = supabase.table("digital_orders").select("status").eq("id", row["digital_order_id"]).maybe_single().execute().data
    if not order or order.get("status") != "approved":
        raise HTTPException(status_code=409, detail="Approve the online order before recording its deposit")
    changed = supabase.table("sushi_boat_deposits").update({
        "collected_at": datetime.now(timezone.utc).isoformat(), "collected_by": user.id,
    }).eq("id", deposit_id).is_("collected_at", "null").execute()
    if not changed.data:
        raise HTTPException(status_code=409, detail="Deposit was updated by another staff member")
    return changed.data[0]


@router.post("/sushi-boat-deposits/{deposit_id}/handoff")
def handoff_sushi_boat_deposit(deposit_id: str, user: CurrentUser = Depends(get_current_user)):
    _require_deposit_staff(user)
    supabase = get_supabase()
    row = supabase.table("sushi_boat_deposits").select("*").eq("id", deposit_id).maybe_single().execute().data
    if not row:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if not row.get("collected_at"):
        raise HTTPException(status_code=409, detail="Record deposit collection before handoff")
    if row.get("handoff_at"):
        raise HTTPException(status_code=409, detail="Boat handoff is already recorded")
    handed_at = datetime.now(timezone.utc)
    changed = supabase.table("sushi_boat_deposits").update({
        "handoff_at": handed_at.isoformat(), "handed_by": user.id,
        "return_due_at": (handed_at + timedelta(hours=24)).isoformat(),
    }).eq("id", deposit_id).is_("handoff_at", "null").execute()
    if not changed.data:
        raise HTTPException(status_code=409, detail="Boat handoff was recorded by another staff member")
    return changed.data[0]


@router.post("/sushi-boat-deposits/{deposit_id}/return")
def return_sushi_boat_deposit(deposit_id: str, body: BoatDepositReturnRequest, user: CurrentUser = Depends(get_current_user)):
    _require_deposit_staff(user)
    supabase = get_supabase()
    row = supabase.table("sushi_boat_deposits").select("*").eq("id", deposit_id).maybe_single().execute().data
    if not row:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if not row.get("handoff_at"):
        raise HTTPException(status_code=409, detail="Record the boat handoff before its return")
    if row.get("returned_at"):
        raise HTTPException(status_code=409, detail="Boat return is already recorded")
    deduction = round(float(body.deduction_amount), 2)
    amount = round(float(row["amount"]), 2)
    if deduction > amount:
        raise HTTPException(status_code=400, detail="Deductions cannot exceed the deposit")
    payload = {
        "returned_at": datetime.now(timezone.utc).isoformat(), "returned_by": user.id,
        "deduction_amount": deduction, "refund_amount": round(amount - deduction, 2),
        "refund_method": body.refund_method.strip(),
        "refund_reference": body.refund_reference.strip() if body.refund_reference else None,
        "notes": body.notes.strip() if body.notes else None,
    }
    changed = supabase.table("sushi_boat_deposits").update(payload).eq("id", deposit_id).is_("returned_at", "null").execute()
    if not changed.data:
        raise HTTPException(status_code=409, detail="Boat return was recorded by another staff member")
    return changed.data[0]


def _fire_digital_order(supabase, order: dict, actor_id: str):
    """Turn a (fully fetched) digital order into a real transaction -- the
    kitchen ticket, stock deduction and print all key off this. Shared by
    immediate approval and by the deferred firing of scheduled orders."""
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
        employee_id=actor_id,
        items=[
            TransactionItemCreate(
                product_size_id=i["product_size_id"],
                quantity=i["quantity"],
                held_ingredients=i.get("held_ingredients", []),
            )
            for i in order["items"]
        ],
        payment_method=pos_payment_method,
        # Delivery orders are deliveries (they show on the Deliveries page with
        # an Online origin); pickup orders are takeout.
        order_type={"delivery": "delivery", "pickup": "takeout"}.get(order.get("order_channel")),
        order_source="qr" if order.get("order_channel") == "dine_in_qr" else "online",
        # Cash is collected by the rider or at the counter, so the sale stays
        # unpaid until the cashier logs it (Online Orders → Cash received).
        pay_on_delivery=pos_payment_method == "cash" and order.get("order_channel") in ("delivery", "pickup"),
    )

    # Add-ons aren't real catalog products, so they were never part of
    # _create_transaction_row's items -- fold their (taxed) cost into the
    # transaction's totals now so the till reconciles correctly. Same for a
    # delivery's fee, which isn't a catalog item either. The digital_orders
    # row (linked via transaction_id) remains the record of exactly what was
    # ordered and, for delivery, what the fee was.
    delivery_fee = float(order["delivery"]["delivery_fee"]) if order.get("delivery") and order["delivery"].get("delivery_fee") else 0.0
    # Packaging is a customer charge for pickup/delivery, while the boat
    # deposit is refundable and remains outside sales revenue.
    addons_subtotal = (
        sum(float(a["unit_price"]) * a["quantity"] for a in order["addons"])
        + delivery_fee
        + float(order.get("packaging_fee") or 0)
    )
    # The free first-order item was priced from the catalog like any line;
    # make it ₱0 and take its price back off the totals.
    promo_credit = _zero_promo_lines(supabase, order, transaction)
    adjustment = addons_subtotal - promo_credit
    if adjustment:
        supabase.table("transactions").update(
            {
                "total_amount": transaction.total_amount + adjustment,
                "tax_amount": transaction.tax_amount + adjustment * _get_vat_rate(supabase),
            }
        ).eq("id", transaction.id).execute()
    return transaction


def _zero_promo_lines(supabase, order: dict, transaction) -> float:
    promo_sizes = [i["product_size_id"] for i in order["items"] if i.get("is_promo")]
    credit = 0.0
    lines = list(transaction.items)
    for size_id in promo_sizes:
        # The promo line was inserted last, so it is the last line of that size.
        line = next((l for l in reversed(lines) if l.product_size_id == size_id and float(l.unit_price) > 0), None)
        if line is None:
            continue
        credit += float(line.unit_price) * float(line.quantity)
        supabase.table("transaction_items").update({"unit_price": 0}).eq("id", line.id).execute()
        lines.remove(line)
    return credit


def _parse_scheduled_for(order: dict) -> datetime | None:
    raw = order.get("scheduled_for")
    if not raw:
        return None
    return TypeAdapter(datetime).validate_python(raw)


@router.post("/digital-orders/{order_id}/approve", response_model=DigitalOrderResponse)
def approve_digital_order(order_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    order = _fetch_digital_order(supabase, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Order is already {order['status']}")

    update = {
        "status": "approved",
        "approved_by": user.id,
        "approved_at": datetime.now(timezone.utc).isoformat(),
    }
    scheduled_for = _parse_scheduled_for(order)
    lead = timedelta(minutes=ADVANCE_ORDER_LEAD_MINUTES)
    if scheduled_for is not None and scheduled_for > datetime.now(timezone.utc) + lead:
        # Advance order approved well ahead of time: confirm it now, but hold
        # it out of the kitchen (no ticket, no print, no stock deduction)
        # until _fire_due_scheduled_orders releases it 20 min before.
        pass
    else:
        update["transaction_id"] = _fire_digital_order(supabase, order, user.id).id

    updated = supabase.table("digital_orders").update(update).eq("id", order_id).execute()
    result = updated.data[0]
    # Approving a non-cash order means staff verified its payment proof. The
    # boat deposit is included in that transfer and can be marked collected
    # here; cash-on-pickup/delivery deposits remain for the ledger tab.
    if float(order.get("boat_deposit") or 0) > 0 and order.get("payment_method") != "cash":
        supabase.table("sushi_boat_deposits").update({
            "collected_at": update["approved_at"], "collected_by": user.id,
        }).eq("digital_order_id", order_id).is_("collected_at", "null").execute()
    result["items"] = order["items"]
    result["addons"] = order["addons"]
    result["delivery"] = order.get("delivery")
    return result


# Firing is triggered from GET /transactions (polled by Kitchen Display, Order
# Queue and the print bridge). If the scheduled_for/kitchen_fired_at columns
# don't exist yet (migration 0054 not applied) or the DB hiccups, back off so
# every poll doesn't repeat a failing query.
_fire_backoff_until = 0.0
_fire_next_check = 0.0
FIRE_CHECK_SECONDS = 20


def fire_due_scheduled_orders(supabase) -> int:
    """Release approved advance orders whose requested time is within the
    lead window into the kitchen. Safe to call from many concurrent pollers:
    each order is claimed with one conditional UPDATE, so exactly one caller
    fires it. Never raises."""
    global _fire_backoff_until, _fire_next_check
    now = time.monotonic()
    if now < _fire_backoff_until or now < _fire_next_check:
        return 0
    # Every list poll calls this; checking once per 20 s per instance is plenty
    # against a 20-minute lead window, and saves a query (CPU) on most polls.
    _fire_next_check = now + FIRE_CHECK_SECONDS
    fired = 0
    try:
        horizon = (datetime.now(timezone.utc) + timedelta(minutes=ADVANCE_ORDER_LEAD_MINUTES)).isoformat()
        due = (
            supabase.table("digital_orders")
            .select("id, approved_by")
            .eq("status", "approved")
            .is_("transaction_id", "null")
            .is_("kitchen_fired_at", "null")
            .not_.is_("scheduled_for", "null")
            .lte("scheduled_for", horizon)
            .execute()
            .data
        )
        for row in due:
            claim = (
                supabase.table("digital_orders")
                .update({"kitchen_fired_at": datetime.now(timezone.utc).isoformat()})
                .eq("id", row["id"])
                .is_("kitchen_fired_at", "null")
                .execute()
            )
            if not claim.data:
                continue  # another poller won the claim
            try:
                order = _fetch_digital_order(supabase, row["id"])
                transaction = _fire_digital_order(supabase, order, row["approved_by"])
                supabase.table("digital_orders").update({"transaction_id": transaction.id}).eq("id", row["id"]).execute()
                fired += 1
            except Exception:
                # Release the claim so the next poll retries this order.
                supabase.table("digital_orders").update({"kitchen_fired_at": None}).eq("id", row["id"]).execute()
                raise
    except Exception:
        _fire_backoff_until = time.monotonic() + 60
    return fired


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
    # A declined first order gives the free item back to the next customer today.
    try:
        supabase.table("online_promo_claims").delete().eq("digital_order_id", order_id).execute()
    except APIError:
        pass
    result["items"] = order["items"]
    result["addons"] = order["addons"]
    result["delivery"] = order.get("delivery")
    return result
