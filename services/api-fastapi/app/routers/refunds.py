"""Refund approval flow (WS-12): void is narrowed to `queued` orders only
(transactions.py's void_transaction) -- once an order is preparing, ready
or completed, a cashier files a refund request here instead, and an
admin/executive must approve or reject it. Approving performs the actual
void via void_transaction_core directly, deliberately bypassing that
endpoint's own queued-only gate.

Completed orders are refundable too (2026-10-29: double punches and
refunds asked for after the kitchen bumped the order). The approver
chooses whether the stock goes back: by default it does, unless the order
was completed -- then the food was usually served. The money side is
unchanged: shift reports keep counting the paid sale, and any cash handed
back is recorded separately as a Shift Reports cash refund.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.routers.transactions import _fetch_transaction_with_items, void_transaction_core
from app.schemas import RefundApproveRequest, RefundCreateRequest, RefundOut

router = APIRouter(tags=["refunds"])


def _decorate(supabase, rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    tx_ids = list({r["transaction_id"] for r in rows})
    tx_result = (
        supabase.table("transactions")
        .select("id, order_number, total_amount, kitchen_status, opened_at, order_type, payment_method, payment_status")
        .in_("id", tx_ids)
        .execute()
    )
    tx_by_id = {t["id"]: t for t in tx_result.data}
    item_rows = (
        supabase.table("transaction_items")
        .select("transaction_id, quantity, product_sizes(size_label, products(name))")
        .in_("transaction_id", tx_ids)
        .execute()
        .data
    )
    items: dict[str, list[str]] = {}
    for row in item_rows:
        size = row.get("product_sizes") or {}
        name = (size.get("products") or {}).get("name") or "Item"
        label = size.get("size_label")
        items.setdefault(row["transaction_id"], []).append(
            f"{float(row['quantity']):g}× {name}" + (f" ({label})" if label and label != "Regular" else "")
        )
    for r in rows:
        tx = tx_by_id.get(r["transaction_id"]) or {}
        for field in ("order_number", "total_amount", "kitchen_status", "opened_at", "order_type",
                      "payment_method", "payment_status"):
            r[field] = tx.get(field)
        r["items"] = items.get(r["transaction_id"], [])
    return rows


@router.post("/refunds", response_model=RefundOut)
def create_refund(body: RefundCreateRequest, user: CurrentUser = Depends(get_current_user)):
    if user.role == "kitchen":
        raise HTTPException(status_code=403, detail="Kitchen accounts can't request refunds")
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
    # Refund is the correction path for an order past the point of direct
    # self-service void: a still-`queued` order should use Void instead.
    if tx.get("kitchen_status") == "queued":
        raise HTTPException(status_code=409, detail="This order is still queued -- void it directly instead")

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
def approve_refund(
    refund_id: str,
    body: RefundApproveRequest | None = None,
    user: CurrentUser = Depends(get_current_user),
):
    require_role_or_grant(user, "refund-approval", "manager", "executive")
    supabase = get_supabase()
    refund = _fetch_pending_refund(supabase, refund_id)

    transaction = _fetch_transaction_with_items(supabase, refund["transaction_id"])
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    restore_stock = body.restore_stock if body and body.restore_stock is not None else (
        transaction.get("kitchen_status") != "completed"
    )
    if transaction["status"] != "voided":
        reason = f"Refund approved: {refund['reason']}" + ("" if restore_stock else " (stock not returned)")
        void_transaction_core(supabase, transaction, user.id, reason, restore_stock=restore_stock)

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
