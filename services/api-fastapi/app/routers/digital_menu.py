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

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.routers.products import _list_products_data
from app.routers.recipes import _get_recipe_data
from app.routers.transactions import VAT_RATE, _create_transaction_row
from app.schemas import (
    CreateDigitalOrderRequest,
    DigitalOrderResponse,
    DigitalOrderStatusResponse,
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


@router.post("/public/orders", response_model=DigitalOrderStatusResponse)
def submit_digital_order(body: CreateDigitalOrderRequest):
    if not body.items:
        raise HTTPException(status_code=400, detail="Order must have at least one item")
    supabase = get_supabase()

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

    order_insert = (
        supabase.table("digital_orders")
        .insert(
            {
                "table_number": body.table_number,
                "status": "pending",
                "payment_method": body.payment_method,
                "customer_note": body.customer_note,
                "subtotal": subtotal,
            }
        )
        .execute()
    )
    order = order_insert.data[0]

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

    return _fetch_digital_order(supabase, order["id"])


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

    for order in orders:
        order["items"] = items_by_order.get(order["id"], [])
        order["addons"] = addons_by_order.get(order["id"], [])
    return orders


@router.post("/digital-orders/{order_id}/approve", response_model=DigitalOrderResponse)
def approve_digital_order(order_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    order = _fetch_digital_order(supabase, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Order is already {order['status']}")

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
    )

    # Add-ons aren't real catalog products, so they were never part of
    # _create_transaction_row's items -- fold their (taxed) cost into the
    # transaction's totals now so the till reconciles correctly. The
    # digital_orders row (linked via transaction_id) remains the record of
    # exactly which add-ons were ordered.
    addons_subtotal = sum(float(a["unit_price"]) * a["quantity"] for a in order["addons"])
    if addons_subtotal:
        supabase.table("transactions").update(
            {
                "total_amount": transaction.total_amount + addons_subtotal,
                "tax_amount": transaction.tax_amount + addons_subtotal * VAT_RATE,
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
    return result
