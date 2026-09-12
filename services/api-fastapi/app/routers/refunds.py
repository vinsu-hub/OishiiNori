"""Refund approval flow (WS-12): void is narrowed to `queued` orders only
(transactions.py's void_transaction) -- once an order is preparing or
ready, a cashier files a refund request here instead, and an
admin/executive must approve or reject it. A completed order can't be
touched by either path. Approving performs the actual void (stock restore
etc.) via void_transaction_core directly, deliberately bypassing that
endpoint's own queued-only gate -- an already-approved refund is
authorized regardless of the order's current kitchen_status (e.g. it may
have advanced to ready while the request sat pending review).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.routers.transactions import _fetch_transaction_with_items, void_transaction_core
from app.schemas import RefundCreateRequest, RefundOut

router = APIRouter(tags=["refunds"])


def _decorate(supabase, rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    tx_ids = list({r["transaction_id"] for r in rows})
    tx_result = (
        supabase.table("transactions").select("id, order_number, total_amount").in_("id", tx_ids).execute()
    )
    tx_by_id = {t["id"]: t for t in tx_result.data}
    for r in rows:
        tx = tx_by_id.get(r["transaction_id"])
        r["order_number"] = tx.get("order_number") if tx else None
        r["total_amount"] = tx.get("total_amount") if tx else None
    return rows


@router.post("/refunds", response_model=RefundOut)
def create_refund(body: RefundCreateRequest, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    tx_result = (
        supabase.table("transactions")
        .select("id, employee_id, status, kitchen_status")
        .eq("id", body.transaction_id)
        .maybe_single()
        .execute()
    )
    if not tx_result or not tx_result.data:
        raise HTTPException(status_code=404, detail="Transaction not found")
    tx = tx_result.data
    if user.role == "employee" and tx["employee_id"] != user.id:
        raise HTTPException(status_code=403, detail="Employees may only request a refund on their own orders")
    if tx["status"] == "voided":
        raise HTTPException(status_code=400, detail="Transaction is already voided")
    # Refund is the correction path specifically for an order that's past
    # the point of direct self-service void: still-`queued` orders should
    # use Void instead, and `completed` orders can't be touched at all.
    if tx.get("kitchen_status") not in ("preparing", "ready"):
        raise HTTPException(
            status_code=409,
            detail="Only an order that's preparing or ready can be refund-requested "
            "(a queued order can be voided directly; a completed order can't be corrected at all)",
        )

    existing = (
        supabase.table("refunds")
        .select("id")
        .eq("transaction_id", body.transaction_id)
        .eq("status", "pending")
        .maybe_single()
        .execute()
    )
    if existing and existing.data:
        raise HTTPException(status_code=409, detail="A refund request is already pending for this order")

    if not body.reason.strip():
        raise HTTPException(status_code=400, detail="A reason is required")

    result = (
        supabase.table("refunds")
        .insert({"transaction_id": body.transaction_id, "requested_by": user.id, "reason": body.reason.strip()})
        .execute()
    )
    return _decorate(supabase, result.data)[0]


@router.get("/refunds", response_model=list[RefundOut])
def list_refunds(user: CurrentUser = Depends(get_current_user)):
    """Manager/executive only -- the Refund Approval tab."""
    require_role_or_grant(user, "refund-approval", "manager", "executive")
    supabase = get_supabase()
    result = supabase.table("refunds").select("*").order("requested_at", desc=True).execute()
    return _decorate(supabase, result.data)


def _fetch_pending_refund(supabase, refund_id: str) -> dict:
    result = supabase.table("refunds").select("*").eq("id", refund_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Refund request not found")
    refund = result.data
    if refund["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Refund request is already {refund['status']}")
    return refund


@router.post("/refunds/{refund_id}/approve", response_model=RefundOut)
def approve_refund(refund_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "refund-approval", "manager", "executive")
    supabase = get_supabase()
    refund = _fetch_pending_refund(supabase, refund_id)

    transaction = _fetch_transaction_with_items(supabase, refund["transaction_id"])
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    # A completed order is untouchable no matter how it got there -- if the
    # kitchen finished it while this request sat pending review, reject
    # rather than silently voiding a completed sale.
    if transaction.get("kitchen_status") == "completed":
        raise HTTPException(
            status_code=409,
            detail="This order was completed while the refund request was pending -- it can no longer be voided",
        )
    if transaction["status"] != "voided":
        void_transaction_core(supabase, transaction, user.id, f"Refund approved: {refund['reason']}")

    updated = (
        supabase.table("refunds")
        .update({"status": "approved", "reviewed_by": user.id, "reviewed_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", refund_id)
        .execute()
    )
    return _decorate(supabase, updated.data)[0]


@router.post("/refunds/{refund_id}/reject", response_model=RefundOut)
def reject_refund(refund_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "refund-approval", "manager", "executive")
    supabase = get_supabase()
    _fetch_pending_refund(supabase, refund_id)

    updated = (
        supabase.table("refunds")
        .update({"status": "rejected", "reviewed_by": user.id, "reviewed_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", refund_id)
        .execute()
    )
    return _decorate(supabase, updated.data)[0]
