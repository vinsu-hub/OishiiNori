"""Business Day cycle (WS-13): POS is locked until the cashier confirms
Start-of-Day (their OWN kiosk ID+PIN, re-verified the same way Owner's
Request / the reservation override already do via verify_employee_pin)
plus a menu-up-to-date acknowledgement. End-of-Day records the cashier's
counted cash-register total; the system's own EOD revenue total is
computed and stored at close time but never returned to a non-manager/
executive caller -- BusinessDayStatusOut (used by /today, /open, /close)
simply has no field for it.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role, require_role_or_grant, verify_employee_pin
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc, today_ph
from app.schemas import (
    BusinessDayAdminOut,
    BusinessDayCloseRequest,
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


def _status_out(d, row: dict | None) -> dict:
    if not row or row["closed_at"] is not None:
        return {"business_date": d, "is_open": False, "opened_at": None, "menu_confirmed": None}
    return {
        "business_date": d,
        "is_open": True,
        "opened_at": row["opened_at"],
        "menu_confirmed": row["menu_confirmed"],
    }


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
    return _status_out(d, _fetch_today(supabase, d))


@router.post("/business-days/open", response_model=BusinessDayStatusOut)
def open_business_day(body: BusinessDayOpenRequest, user: CurrentUser = Depends(get_current_user)):
    _verify_self(body.employee_number, body.pin, user)
    supabase = get_supabase()
    d = today_ph()

    existing = _fetch_today(supabase, d)
    if existing and existing["closed_at"] is None:
        raise HTTPException(status_code=409, detail="Today's business day is already open")
    if existing and existing["closed_at"] is not None:
        # business_date is unique -- a day, once closed, can't be reopened
        # (matches WS-13's own semantics: End-of-Day is a one-way close).
        raise HTTPException(status_code=409, detail="Today's business day was already closed and can't be reopened")

    result = (
        supabase.table("business_days")
        .insert(
            {
                "business_date": d.isoformat(),
                "opened_by": user.id,
                "menu_confirmed": body.menu_confirmed,
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

    existing = _fetch_today(supabase, d)
    if not existing:
        raise HTTPException(status_code=404, detail="Today's business day was never opened")
    if existing["closed_at"] is not None:
        raise HTTPException(status_code=409, detail="Today's business day is already closed")

    start, end = ph_day_bounds_utc(d)
    tx_result = (
        supabase.table("transactions")
        .select("total_amount")
        .gte("opened_at", start)
        .lte("opened_at", end)
        .neq("status", "voided")
        .execute()
    )
    system_eod_total = sum(float(t["total_amount"]) for t in tx_result.data)

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
    rows = []
    for row in result.data:
        variance = None
        if row.get("cash_register_total") is not None and row.get("system_eod_total") is not None:
            variance = float(row["cash_register_total"]) - float(row["system_eod_total"])
        rows.append({**row, "variance": variance})
    return rows
