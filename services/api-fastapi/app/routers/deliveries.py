"""Rider-facing delivery panel (WS-8). A rider account sees exactly the
current/pending deliveries -- approved `delivery`-channel digital orders,
PLUS (0051) POS-charged walk-in "Delivery" orders -- that haven't been
marked done yet, with the order ticket, customer details, and an optional
Google Maps pin link. Manager/executive can see the same list for oversight.

A `deliveries` row now originates from either `digital_order_id` (a QR
delivery order, approved into a transaction) or `transaction_id` (a walk-in
delivery rung up directly at the POS) -- exactly one of the two is ever
set (0051's `deliveries_exactly_one_source` constraint). Both are adapted
into the same `DigitalOrderResponse` shape so the rider UI below needs no
changes regardless of where an order started.
"""

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import TypeAdapter

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.routers.digital_menu import (
    _fetch_digital_order, _parse_scheduled_for, select_digital_order_details, unpack_digital_orders,
)
from app.routers.reservations import ADVANCE_ORDER_LEAD_MINUTES
from app.routers.transactions import (
    _deliveries_transaction_id_supported_check, fetch_transaction_delivery_ticket, fetch_transaction_delivery_tickets,
    live_cache_get, live_cache_put, live_cache_version,
)
from app.schemas import DigitalOrderResponse

router = APIRouter(tags=["deliveries"])

RIDER_PENDING_DAYS = 2
COMPLETED_DELIVERIES_LIMIT = 100


@router.get("/deliveries", response_model=list[DigitalOrderResponse])
def list_deliveries(
    status: Literal["pending", "completed", "all"] = Query("pending"),
    user: CurrentUser = Depends(get_current_user),
):
    """Default (`pending`) is the rider's own working queue -- unchanged
    behavior, every existing caller (Delivery.tsx) keeps working exactly
    as before. `completed`/`all` are for the admin/executive monitoring
    tab on Delivery Requests, restricted below to manager/executive since
    a rider has no reason to browse delivery history."""
    require_role(user, "rider", "manager", "executive")
    if status != "pending":
        require_role(user, "manager", "executive")
    # Riders' phones poll this every 15 s for the "ready for pickup" alert;
    # the shared live cache rebuilds it only when orders/deliveries change.
    cache_key = ("deliveries", status)
    body = live_cache_get(cache_key)
    if body is not None:
        return Response(body, media_type="application/json")
    version = live_cache_version()
    return live_cache_put(cache_key, _deliveries_json.dump_json(
        _deliveries_json.validate_python(_build_deliveries(status))), version)


_deliveries_json = TypeAdapter(list[DigitalOrderResponse])


def _pending_ticket_ids(supabase) -> tuple[list[str], list[str]]:
    """(digital order ids, transaction ids) still on the rider's plate. Most
    finished deliveries are never tapped "done", so undelivered rows pile up
    for good: ~5 a day, 166 by 2026-11, each one rebuilt on every order change.
    A paid order the kitchen finished days ago isn't being delivered any more;
    unpaid ones stay, since their cash is still out."""
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=RIDER_PENDING_DAYS)).isoformat()
    horizon = now + timedelta(minutes=ADVANCE_ORDER_LEAD_MINUTES)
    active = f"opened_at.gte.{cutoff},kitchen_status.neq.completed,payment_status.eq.unpaid"
    transaction_ids = [
        row["id"] for row in (
            supabase.table("transactions").select("id, deliveries!inner(delivered_at)")
            .eq("order_type", "delivery").neq("status", "voided").or_(active)
            .is_("deliveries.delivered_at", "null").execute().data
        )
    ]
    online = (
        supabase.table("digital_orders")
        .select("id, scheduled_for, deliveries!inner(delivered_at), transactions(status, kitchen_status, payment_status, opened_at)")
        .eq("order_channel", "delivery").eq("status", "approved")
        .is_("deliveries.delivered_at", "null").execute().data
    )
    order_ids = []
    for row in online:
        # A scheduled order isn't waiting on a rider until its prep window.
        scheduled = _parse_scheduled_for(row)
        if scheduled and scheduled > horizon:
            continue
        tx = row.get("transactions")
        if tx and tx["status"] != "voided" and tx["kitchen_status"] == "completed" \
                and tx["payment_status"] != "unpaid" and tx["opened_at"] < cutoff:
            continue
        order_ids.append(row["id"])
    return order_ids, transaction_ids


def _build_deliveries(status: str) -> list[dict]:
    supabase = get_supabase()

    if status == "pending":
        order_ids, transaction_ids = _pending_ticket_ids(supabase)
    else:
        deliveries_query = supabase.table("deliveries").select("digital_order_id, transaction_id")
        if status == "completed":
            deliveries_query = (deliveries_query.not_.is_("delivered_at", "null")
                                .order("delivered_at", desc=True).limit(COMPLETED_DELIVERIES_LIMIT))
        rows = deliveries_query.execute().data
        order_ids = [d["digital_order_id"] for d in rows if d.get("digital_order_id")]
        transaction_ids = [d["transaction_id"] for d in rows if d.get("transaction_id")]

    tickets = []
    if order_ids:
        orders_result = (
            select_digital_order_details(supabase)
            .in_("id", order_ids)
            .eq("order_channel", "delivery")
            .eq("status", "approved")
            .order("created_at")
            .execute()
        )
        tickets.extend(unpack_digital_orders(orders_result.data))
    tickets.extend(fetch_transaction_delivery_tickets(supabase, transaction_ids))

    # One bulk lookup of the backing transactions' state: drops voided orders
    # from the rider's working queue (a voided POS delivery used to linger
    # there) and stamps `kitchen_status` for the "For Pick Up" tab.
    backing_ids = list({t.get("transaction_id") or t["id"] for t in tickets if t.get("transaction_id") or t.get("id")})
    state_by_id: dict[str, dict] = {}
    for i in range(0, len(backing_ids), 200):
        rows = (
            supabase.table("transactions")
            .select("id, status, kitchen_status")
            .in_("id", backing_ids[i : i + 200])
            .execute()
        )
        state_by_id.update({r["id"]: r for r in rows.data})
    visible = []
    for ticket in tickets:
        state = state_by_id.get(ticket.get("transaction_id") or ticket["id"])
        if state:
            if status == "pending" and state["status"] == "voided":
                continue
            ticket["kitchen_status"] = state.get("kitchen_status")
        visible.append(ticket)
    visible.sort(key=lambda t: t["created_at"])
    return visible


@router.post("/deliveries/{order_id}/done", response_model=DigitalOrderResponse)
def mark_delivery_done(order_id: str, user: CurrentUser = Depends(get_current_user)):
    """`order_id` is either a digital_order id or a transaction id -- the
    rider UI passes back whatever `id` the ticket it's looking at carries,
    never knowing (or needing to know) which source it came from."""
    require_role(user, "rider", "manager", "executive")
    supabase = get_supabase()

    if _deliveries_transaction_id_supported_check(supabase):
        existing = (
            supabase.table("deliveries")
            .select("id, digital_order_id, transaction_id, delivered_at")
            .or_(f"digital_order_id.eq.{order_id},transaction_id.eq.{order_id}")
            .maybe_single()
            .execute()
        )
    else:
        existing = (
            supabase.table("deliveries")
            .select("id, digital_order_id, delivered_at")
            .eq("digital_order_id", order_id)
            .maybe_single()
            .execute()
        )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Delivery not found")
    if existing.data["delivered_at"] is not None:
        raise HTTPException(status_code=400, detail="Delivery is already marked done")

    supabase.table("deliveries").update(
        {"rider_id": user.id, "delivered_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", existing.data["id"]).execute()

    if existing.data.get("digital_order_id"):
        return _fetch_digital_order(supabase, existing.data["digital_order_id"])
    return fetch_transaction_delivery_ticket(supabase, existing.data["transaction_id"])
