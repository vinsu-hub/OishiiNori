"""Kitchen print bridge status: kitchen-print-bridge/bridge.py (running
on-prem next to the XP-58H) posts a heartbeat here on every poll cycle --
"ok" (with an order number if it just printed) or "error" (with what went
wrong). dashboard-web's Printer Setup tab reads it back so staff can tell
whether the bridge is alive without any direct network path to its
machine. Singleton row, same posture as settings.py's business settings.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.schemas import KitchenPrinterHeartbeat, KitchenPrinterStatusOut

router = APIRouter(tags=["kitchen-printer"])


@router.post("/kitchen-printer/heartbeat", response_model=KitchenPrinterStatusOut)
def post_heartbeat(body: KitchenPrinterHeartbeat, user: CurrentUser = Depends(get_current_user)):
    """Any authenticated user may report a heartbeat -- in practice only the
    bridge's own dedicated low-privilege account ever calls this, same trust
    model as it already has for GET /transactions and GET /products."""
    supabase = get_supabase()
    now = datetime.now(timezone.utc).isoformat()
    payload: dict = {"last_heartbeat_at": now, "updated_at": now}
    if body.status == "ok" and body.printed_order_number is not None:
        payload["last_print_at"] = now
        payload["last_print_order_number"] = body.printed_order_number
    elif body.status == "error":
        payload["last_error"] = body.error_message or "Unknown error"
        payload["last_error_at"] = now
    updated = supabase.table("kitchen_printer_status").update(payload).eq("id", 1).execute()
    return updated.data[0]


@router.get("/kitchen-printer/status", response_model=KitchenPrinterStatusOut)
def get_status(user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "printer-setup", "manager", "executive")
    supabase = get_supabase()
    result = supabase.table("kitchen_printer_status").select("*").eq("id", 1).maybe_single().execute()
    return result.data if result and result.data else KitchenPrinterStatusOut()
