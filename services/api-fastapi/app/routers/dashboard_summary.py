from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, Query
from postgrest.exceptions import APIError

from app.attendance_utils import hr_table
from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc
from app.routers.inventory import get_low_stock_ingredients
from app.schemas import (
    DashboardSummaryResponse,
    DepartmentBreakdown,
    UtilityCostBreakdown,
)

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard/summary", response_model=DashboardSummaryResponse)
def get_dashboard_summary(
    on_date: date | None = Query(None, alias="date"),
    user: CurrentUser = Depends(get_current_user),
):
    """Single-location rollup for Command Center (executive only) -- revenue/
    loss/inventory/utility for one business day, plus a best-effort staff-
    clocked-in count. The hr schema may not be exposed on Supabase yet
    (see hr.py's other endpoints); rather than 500 the whole summary over
    that, this degrades staff_clocked_in to None / hr_available=False, same
    resilience pattern as transactions.py's kitchen_status feature
    detection."""
    require_role(user, "executive")
    if on_date is None:
        on_date = date.today()

    supabase = get_supabase()
    start, end = ph_day_bounds_utc(on_date)

    transactions_result = (
        supabase.table("transactions")
        .select("id, total_amount, discount_amount, tax_amount")
        .gte("opened_at", start)
        .lte("opened_at", end)
        .neq("status", "voided")
        .execute()
    )
    transactions = transactions_result.data
    revenue = sum(float(t["total_amount"]) for t in transactions)
    discount_total = sum(float(t["discount_amount"]) for t in transactions)
    tax_total = sum(float(t["tax_amount"]) for t in transactions)
    order_count = len(transactions)

    loss_result = (
        supabase.table("loss_records")
        .select("cost_impact")
        .gte("created_at", start)
        .lte("created_at", end)
        .execute()
    )
    loss_total = sum(float(r["cost_impact"]) for r in loss_result.data)

    low_stock = get_low_stock_ingredients(supabase)

    # Same consumption/cost formula as UtilityLog.tsx's client-side preview
    # (reading_end - reading_start if both given, else quantity; cost =
    # consumption * unit_cost) -- kept in sync rather than re-derived here.
    utility_result = (
        supabase.table("utility_logs")
        .select("utility_type, reading_start, reading_end, quantity, unit_cost")
        .eq("business_date", on_date.isoformat())
        .execute()
    )
    utility_by_type: dict[str, float] = defaultdict(float)
    for log in utility_result.data:
        if log["reading_end"] is not None and log["reading_start"] is not None:
            consumption = float(log["reading_end"]) - float(log["reading_start"])
        elif log["quantity"] is not None:
            consumption = float(log["quantity"])
        else:
            consumption = None
        if consumption is not None:
            utility_by_type[log["utility_type"]] += consumption * float(log["unit_cost"])
    utility_breakdown = [UtilityCostBreakdown(utility_type=k, cost=v) for k, v in utility_by_type.items()]
    utility_cost_today = sum(utility_by_type.values())

    # Item-level gross revenue by department -- an approximation (pre-
    # discount/tax, which apply at the transaction level, not per item) used
    # only for the department split; the headline revenue/discount/tax
    # figures above are the authoritative transaction-level totals.
    by_department: dict[str, dict[str, float]] = defaultdict(lambda: {"item_revenue": 0.0, "item_count": 0.0})
    transaction_ids = [t["id"] for t in transactions]
    if transaction_ids:
        items_result = (
            supabase.table("transaction_items")
            .select("quantity, unit_price, product_sizes(products(department))")
            .in_("transaction_id", transaction_ids)
            .execute()
        )
        for item in items_result.data:
            dept = item["product_sizes"]["products"]["department"]
            by_department[dept]["item_revenue"] += float(item["unit_price"]) * float(item["quantity"])
            by_department[dept]["item_count"] += float(item["quantity"])
    department_rows = [
        DepartmentBreakdown(department=dept, item_revenue=v["item_revenue"], item_count=v["item_count"])
        for dept, v in by_department.items()
    ]

    staff_clocked_in = None
    hr_available = True
    try:
        attendance_result = hr_table("attendance_logs").select("id").eq("status", "working").execute()
        staff_clocked_in = len(attendance_result.data)
    except APIError:
        hr_available = False

    return DashboardSummaryResponse(
        date=on_date,
        revenue=revenue,
        discount_total=discount_total,
        tax_total=tax_total,
        order_count=order_count,
        loss_total=loss_total,
        low_stock_ingredients=low_stock,
        utility_cost_today=utility_cost_today,
        utility_breakdown=utility_breakdown,
        by_department=department_rows,
        staff_clocked_in=staff_clocked_in,
        hr_available=hr_available,
    )
