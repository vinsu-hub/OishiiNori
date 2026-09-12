"""Rider-facing delivery panel (WS-8). A rider account sees exactly the
current/pending deliveries -- approved `delivery`-channel digital orders
that haven't been marked done yet -- with the order ticket, customer
details, and an optional Google Maps pin link. Manager/executive can see
the same list for oversight.
"""

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.routers.digital_menu import _fetch_digital_order
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

    deliveries_query = supabase.table("deliveries").select("digital_order_id")
    if status == "pending":
        deliveries_query = deliveries_query.is_("delivered_at", "null")
    elif status == "completed":
        deliveries_query = deliveries_query.not_.is_("delivered_at", "null")
    deliveries_result = deliveries_query.execute()
    order_ids = [d["digital_order_id"] for d in deliveries_result.data]
    if not order_ids:
        return []

    orders_result = (
        supabase.table("digital_orders")
        .select("*")
        .in_("id", order_ids)
        .eq("order_channel", "delivery")
        .eq("status", "approved")
        .order("created_at")
        .execute()
    )
    return [_fetch_digital_order(supabase, o["id"]) for o in orders_result.data]


@router.post("/deliveries/{digital_order_id}/done", response_model=DigitalOrderResponse)
def mark_delivery_done(digital_order_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "rider", "manager", "executive")
    supabase = get_supabase()

    existing = (
        supabase.table("deliveries").select("id, delivered_at").eq("digital_order_id", digital_order_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Delivery not found")
    if existing.data["delivered_at"] is not None:
        raise HTTPException(status_code=400, detail="Delivery is already marked done")

    supabase.table("deliveries").update(
        {"rider_id": user.id, "delivered_at": datetime.now(timezone.utc).isoformat()}
    ).eq("digital_order_id", digital_order_id).execute()

    return _fetch_digital_order(supabase, digital_order_id)
