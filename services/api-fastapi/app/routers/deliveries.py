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

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.routers.digital_menu import _fetch_digital_order
from app.routers.transactions import _deliveries_transaction_id_supported_check, fetch_transaction_delivery_ticket
from app.schemas import DigitalOrderResponse

router = APIRouter(tags=["deliveries"])


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
    supabase = get_supabase()

    # Migration 0051 feature-detection, same posture as transactions.py's
    # other _*_supported_check guards -- selecting a not-yet-existing
    # deliveries.transaction_id column 500s this endpoint outright (a real
    # regression caught in testing), so fall back to the pre-0051
    # digital_order_id-only shape until the migration is applied.
    transaction_source_supported = _deliveries_transaction_id_supported_check(supabase)
    select_columns = "digital_order_id, transaction_id" if transaction_source_supported else "digital_order_id"
    deliveries_query = supabase.table("deliveries").select(select_columns)
    if status == "pending":
        deliveries_query = deliveries_query.is_("delivered_at", "null")
    elif status == "completed":
        deliveries_query = deliveries_query.not_.is_("delivered_at", "null")
    deliveries_result = deliveries_query.execute()
    order_ids = [d["digital_order_id"] for d in deliveries_result.data if d.get("digital_order_id")]
    transaction_ids = (
        [d["transaction_id"] for d in deliveries_result.data if d.get("transaction_id")]
        if transaction_source_supported
        else []
    )

    tickets = []
    if order_ids:
        orders_result = (
            supabase.table("digital_orders")
            .select("id, created_at")
            .in_("id", order_ids)
            .eq("order_channel", "delivery")
            .eq("status", "approved")
            .order("created_at")
            .execute()
        )
        tickets.extend(_fetch_digital_order(supabase, o["id"]) for o in orders_result.data)
    for transaction_id in transaction_ids:
        ticket = fetch_transaction_delivery_ticket(supabase, transaction_id)
        if ticket:
            tickets.append(ticket)
    tickets.sort(key=lambda t: t["created_at"])
    return tickets


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
