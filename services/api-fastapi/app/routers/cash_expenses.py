from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.auth import require_role_or_grant
from app.deps import get_supabase
from app.ph_time import today_ph
from app.routers.sales_insights import _page_rows
from app.routers.business_days import fetch_open_shift
from app.schemas import CashExpenseCreate, CashExpenseResponse

router = APIRouter(tags=["cash-expenses"])


@router.post("/cash-expenses", response_model=CashExpenseResponse)
def create_cash_expense(body: CashExpenseCreate, user: CurrentUser = Depends(get_current_user)):
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="This account cannot log register expenses")
    business_day = fetch_open_shift(get_supabase())
    if not business_day:
        raise HTTPException(status_code=409, detail="The business day is not open for register expenses")
    # The logged-in cashier is always the audit actor; clients cannot submit
    # expenses under someone else's account.
    result = get_supabase().table("cash_expenses").insert({
        "description": body.description.strip(),
        "amount": round(body.amount, 2),
        "business_date": business_day["business_date"],
        "business_day_id": business_day["id"],
        "recorded_by": user.id,
    }).execute()
    return {**result.data[0], "recorded_by_name": user.full_name}


def _with_staff_names(rows: list[dict]) -> list[dict]:
    result = []
    for row in rows:
        profile = row.get("profiles") or {}
        result.append({**{key: value for key, value in row.items() if key != "profiles"},
                       "recorded_by_name": profile.get("full_name")})
    return result


@router.get("/cash-expenses", response_model=list[CashExpenseResponse])
def list_cash_expenses(
    business_date: date | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="This account cannot view register expenses")
    active = fetch_open_shift(get_supabase())
    selected_date = business_date or (date.fromisoformat(active["business_date"]) if active else today_ph())
    rows = _page_rows(get_supabase().table("cash_expenses").select("*, profiles(full_name)")
            .eq("business_date", selected_date.isoformat())
            .order("created_at", desc=True).order("id"))
    return _with_staff_names(rows)


@router.get("/cash-expenses/report", response_model=list[CashExpenseResponse])
def cash_expense_report(
    date_from: date = Query(...),
    date_before: date = Query(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Detailed register withdrawals for the Command Center's selected period."""
    require_role_or_grant(user, "command-center", "manager", "executive")
    if date_before <= date_from or (date_before - date_from).days > 366:
        raise HTTPException(status_code=400, detail="Choose a date range of up to 366 days")
    rows = _page_rows(get_supabase().table("cash_expenses").select("*, profiles(full_name)")
                      .gte("business_date", date_from.isoformat())
                      .lt("business_date", date_before.isoformat())
                      .order("created_at", desc=True).order("id"))
    return _with_staff_names(rows)
