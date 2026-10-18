"""Business Day and shared shift cycle: POS is locked until the cashier confirms
Start-of-Day (their OWN kiosk ID+PIN, re-verified the same way Owner's
Request / the reservation override already do via verify_employee_pin)
plus a menu-up-to-date acknowledgement. End-of-Day records the cashier's
counted cash-register total. New shift reports reveal the expected cash
and difference only after close; BusinessDayStatusOut (used by /today,
/open, /close) never carries those amounts.
"""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role, require_role_or_grant, verify_employee_pin
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc, today_ph
from app.routers.sales_insights import _page_rows, ID_BATCH_SIZE
from app.schemas import (
    BusinessDayAdminOut,
    BusinessDayCloseRequest,
    BusinessDayItemRow,
    BusinessDayItemsResponse,
    BusinessDayOpenRequest,
    BusinessDayStatusOut,
)

router = APIRouter(tags=["business_days"])

_business_days_supported: bool | None = None


def _business_days_supported_check(supabase) -> bool:
    """Migration 0035 must be applied by hand (no automated runner in this
    repo) -- until it lands, degrade to 'not open' instead of a raw 500 on
    every POS page load, same fail-open-until-migrated posture as
    transactions.py's own _business_days_supported_check."""
    global _business_days_supported
    if _business_days_supported is None:
        try:
            supabase.table("business_days").select("id").limit(1).execute()
            _business_days_supported = True
        except APIError:
            _business_days_supported = False
    return _business_days_supported


def _verify_self(employee_number: str, pin: str, user: CurrentUser) -> None:
    """Mirrors the Owner's Request / reservation-override re-verification --
    the acting user re-enters their OWN kiosk credentials, not anyone's."""
    profile = verify_employee_pin(employee_number, pin)
    if not profile or profile["id"] != user.id:
        raise HTTPException(status_code=403, detail="Employee number/PIN did not match your logged-in account")


def _fetch_today(supabase, d) -> dict | None:
    result = (
        supabase.table("business_days")
        .select("*")
        .eq("business_date", d.isoformat())
        .maybe_single()
        .execute()
    )
    return result.data if result else None


def fetch_open_shift(supabase) -> dict | None:
    """The shared shift can remain open after Philippine midnight."""
    rows = (supabase.table("business_days").select("*")
            .is_("closed_at", "null").is_("closing_at", "null")
            .order("opened_at", desc=True).limit(1).execute().data)
    return rows[0] if rows else None


def _status_out(d, row: dict | None) -> dict:
    if not row or row["closed_at"] is not None:
        return {"business_date": row["business_date"] if row else d, "is_open": False, "opened_at": None, "menu_confirmed": None,
                "closed_shift_id": row["id"] if row and row.get("report_version") == 1 else None}
    return {
        "business_date": row["business_date"],
        "is_open": True,
        "opened_at": row["opened_at"],
        "menu_confirmed": row["menu_confirmed"],
    }


def is_open_today(supabase) -> bool:
    """Shared by the public status endpoint and digital_menu.py's own
    submit-time guard -- same fail-open-until-migrated posture as the
    cashier-facing check."""
    d = today_ph()
    if not _business_days_supported_check(supabase):
        return False
    row = fetch_open_shift(supabase)
    return _status_out(d, row)["is_open"]


@router.get("/business-days/today", response_model=BusinessDayStatusOut)
def get_today_status(user: CurrentUser = Depends(get_current_user)):
    """Any authenticated user -- the POS lock check needs this before a
    cashier has necessarily done anything else. Degrades to 'not open'
    (locked) rather than 500ing the whole POS page before migration 0035
    is applied -- see _business_days_supported_check."""
    supabase = get_supabase()
    d = today_ph()
    if not _business_days_supported_check(supabase):
        return _status_out(d, None)
    return _status_out(d, fetch_open_shift(supabase))


@router.get("/public/business-day-status", response_model=BusinessDayStatusOut)
def get_public_today_status(request: Request):
    """Unauthenticated mirror of /business-days/today for customer-menu
    (which has no login) -- BusinessDayStatusOut already carries no
    financial fields, so it's safe to expose without auth."""
    from app.rate_limit import client_ip, local_rate_limit
    local_rate_limit(f"day-status:{client_ip(request)}", limit=30, window_seconds=60)
    supabase = get_supabase()
    d = today_ph()
    if not _business_days_supported_check(supabase):
        return _status_out(d, None)
    return _status_out(d, fetch_open_shift(supabase))


@router.post("/business-days/open", response_model=BusinessDayStatusOut)
def open_business_day(body: BusinessDayOpenRequest, user: CurrentUser = Depends(get_current_user)):
    _verify_self(body.employee_number, body.pin, user)
    supabase = get_supabase()
    d = today_ph()

    if fetch_open_shift(supabase):
        raise HTTPException(status_code=409, detail="A shift is already open")
    existing = _fetch_today(supabase, d)
    if existing:
        # The original one-row-per-date constraint remains in place.
        raise HTTPException(status_code=409, detail="This business date already has a shift")

    result = (
        supabase.table("business_days")
        .insert(
            {
                "business_date": d.isoformat(),
                "opened_by": user.id,
                "menu_confirmed": body.menu_confirmed,
                "starting_cash": round(body.starting_cash, 2),
                "report_version": 1,
            }
        )
        .execute()
    )
    return _status_out(d, result.data[0])


@router.post("/business-days/close", response_model=BusinessDayStatusOut)
def close_business_day(body: BusinessDayCloseRequest, user: CurrentUser = Depends(get_current_user)):
    _verify_self(body.employee_number, body.pin, user)
    supabase = get_supabase()
    d = today_ph()

    existing = fetch_open_shift(supabase)
    if not existing:
        # A server interruption during report assembly can leave the close
        # reservation behind. Permit a retry after five minutes.
        closing = (supabase.table("business_days").select("*").is_("closed_at", "null")
                   .not_.is_("closing_at", "null").order("closing_at", desc=True)
                   .limit(1).execute().data)
        if closing and datetime.fromisoformat(closing[0]["closing_at"]) < datetime.now(timezone.utc) - timedelta(minutes=5):
            supabase.table("business_days").update({"closing_at": None}).eq("id", closing[0]["id"]).eq("closing_at", closing[0]["closing_at"]).execute()
            existing = fetch_open_shift(supabase)
    if not existing:
        raise HTTPException(status_code=404, detail="No shift is open")
    if existing["closed_at"] is not None:
        raise HTTPException(status_code=409, detail="Today's business day is already closed")

    if existing.get("report_version") == 1:
        from app.routers.shift_reports import build_shift_report
        closing_at = datetime.now(timezone.utc)
        reserved = (supabase.table("business_days").update({"closing_at": closing_at.isoformat()})
                    .eq("id", existing["id"]).is_("closed_at", "null")
                    .is_("closing_at", "null").execute().data)
        if not reserved:
            raise HTTPException(status_code=409, detail="Shift is already closing")
        try:
            report = build_shift_report(supabase, existing, closing_at, body.cash_register_total)
            updated = (supabase.table("business_days").update({
                "closed_at": report["closed_at"], "closed_by": user.id,
                "cash_register_total": round(body.cash_register_total, 2),
                "system_eod_total": report["cash_drawer"]["expected_cash"],
                "shift_report": report,
            }).eq("id", existing["id"]).is_("closed_at", "null").execute().data)
        except Exception:
            supabase.table("business_days").update({"closing_at": None}).eq("id", existing["id"]).is_("closed_at", "null").execute()
            raise
        return _status_out(d, updated[0])

    # Legacy shift opened before migration 0069 uses the original close flow.
    d = date.fromisoformat(existing["business_date"])
    start, end = ph_day_bounds_utc(d)
    tx_result = (
        supabase.table("transactions")
        .select("id, total_amount")
        .gte("opened_at", start)
        .lte("opened_at", end)
        .neq("status", "voided")
        .execute()
    )
    # Pay-on-delivery orders (0062) still out with a rider aren't in the
    # drawer yet, so they don't count toward the blind-count comparison.
    unpaid_ids: set[str] = set()
    try:
        unpaid = (
            supabase.table("transactions")
            .select("id")
            .gte("opened_at", start)
            .lte("opened_at", end)
            .eq("payment_status", "unpaid")
            .neq("status", "voided")
            .execute()
        )
        unpaid_ids = {r["id"] for r in unpaid.data}
    except Exception:
        pass
    system_eod_total = sum(float(t["total_amount"]) for t in tx_result.data if t.get("id") not in unpaid_ids)
    # Cash expenses are tracked separately but reduce the expected closing
    # register balance; keep the gross sales figure in each transaction.
    expense_rows = _page_rows(supabase.table("cash_expenses").select("id,amount")
                              .eq("business_date", d.isoformat()).order("id"))
    expenses_total = sum(float(row["amount"]) for row in expense_rows)
    system_eod_total -= expenses_total

    update_result = (
        supabase.table("business_days")
        .update(
            {
                "closed_at": datetime.now(timezone.utc).isoformat(),
                "closed_by": user.id,
                "cash_register_total": body.cash_register_total,
                "system_eod_total": system_eod_total,
            }
        )
        .eq("id", existing["id"])
        .execute()
    )
    return _status_out(d, update_result.data[0])


@router.get("/business-days", response_model=list[BusinessDayAdminOut])
def list_business_days(user: CurrentUser = Depends(get_current_user)):
    """Manager/executive only -- the register-vs-system variance review.
    Cashiers never reach this: BusinessDayAdminOut is the only shape that
    carries cash_register_total/system_eod_total."""
    require_role_or_grant(user, "business-day-report", "manager", "executive")
    supabase = get_supabase()
    result = supabase.table("business_days").select("*").order("business_date", desc=True).execute()
    expense_totals: dict[str, float] = {}
    if result.data:
        expense_rows = _page_rows(supabase.table("cash_expenses").select("id,business_date,amount")
                                  .gte("business_date", min(r["business_date"] for r in result.data))
                                  .lte("business_date", max(r["business_date"] for r in result.data))
                                  .order("id"))
        for expense in expense_rows:
            key = expense["business_date"]
            expense_totals[key] = expense_totals.get(key, 0.0) + float(expense["amount"])
    rows = []
    for row in result.data:
        expenses_total = expense_totals.get(row["business_date"], 0.0)
        # Older closed days predate the expense log and have no adjustment.
        net_system_total = (float(row["system_eod_total"]) if row.get("system_eod_total") is not None else None)
        variance = None
        if row.get("cash_register_total") is not None and net_system_total is not None:
            variance = float(row["cash_register_total"]) - net_system_total
        rows.append({**row, "expenses_total": expenses_total, "variance": variance})
    return rows


@router.get("/business-days/{business_date}/items", response_model=BusinessDayItemsResponse)
def get_business_day_items(business_date: date, user: CurrentUser = Depends(get_current_user)):
    """Items by sold size for every non-voided order, including unpaid."""
    require_role_or_grant(user, "business-day-report", "manager", "executive")
    supabase = get_supabase()
    start, end = ph_day_bounds_utc(business_date)
    transactions = _page_rows(supabase.table("transactions").select("id")
                              .gte("opened_at", start).lte("opened_at", end)
                              .neq("status", "voided").order("id"))
    rows: dict[str, dict] = {}
    ids = [row["id"] for row in transactions]
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        items = _page_rows(supabase.table("transaction_items")
                           .select("id, product_size_id, quantity, unit_price, product_sizes(product_id, size_label, products(name, category))")
                           .in_("transaction_id", ids[offset:offset + ID_BATCH_SIZE]).order("id"))
        for item in items:
            size = item.get("product_sizes") or {}
            product = size.get("products") or {}
            size_id = item.get("product_size_id")
            if not size_id:
                continue
            entry = rows.setdefault(size_id, {
                "product_id": size.get("product_id") or "unknown",
                "product_size_id": size_id,
                "product_name": product.get("name") or "Unknown item",
                "size_label": size.get("size_label") or "Unspecified size",
                "category": product.get("category") or "Uncategorized",
                "quantity_sold": 0.0, "revenue": 0.0,
            })
            quantity = float(item["quantity"])
            entry["quantity_sold"] += quantity
            entry["revenue"] += quantity * float(item["unit_price"])
    items = [
        BusinessDayItemRow(**row) for row in rows.values()
    ]
    return BusinessDayItemsResponse(business_date=business_date, items=items)
