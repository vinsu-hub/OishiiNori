from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc
from app.schemas import SalesTrendPoint, SalesTrendResponse, TopProductRow, TopProductsResponse

router = APIRouter(tags=["analytics"])

DEFAULT_TREND_DAYS = 29  # 30-day window inclusive of today


def _range_bounds(date_from: date, date_to: date) -> tuple[str, str]:
    start, _ = ph_day_bounds_utc(date_from)
    _, end = ph_day_bounds_utc(date_to)
    return start, end


def _resolve_range(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    if date_to is None:
        date_to = date.today()
    if date_from is None:
        date_from = date_to - timedelta(days=DEFAULT_TREND_DAYS)
    return date_from, date_to


@router.get("/analytics/sales-trend", response_model=SalesTrendResponse)
def get_sales_trend(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Real daily revenue/order-count series for Trend Analysis (executive
    only) -- derived from actual transactions, not a mock/hardcoded chart."""
    require_role(user, "executive")
    date_from, date_to = _resolve_range(date_from, date_to)

    supabase = get_supabase()
    start, end = _range_bounds(date_from, date_to)
    result = (
        supabase.table("transactions")
        .select("opened_at, total_amount")
        .gte("opened_at", start)
        .lte("opened_at", end)
        .neq("status", "voided")
        .execute()
    )

    by_day: dict[str, dict[str, float]] = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    for t in result.data:
        day_key = t["opened_at"][:10]
        by_day[day_key]["revenue"] += float(t["total_amount"])
        by_day[day_key]["order_count"] += 1

    points = []
    cursor = date_from
    while cursor <= date_to:
        agg = by_day.get(cursor.isoformat(), {"revenue": 0.0, "order_count": 0})
        points.append(SalesTrendPoint(date=cursor, revenue=agg["revenue"], order_count=int(agg["order_count"])))
        cursor += timedelta(days=1)

    return SalesTrendResponse(
        date_from=date_from,
        date_to=date_to,
        points=points,
        total_revenue=sum(p.revenue for p in points),
        total_orders=sum(p.order_count for p in points),
    )


@router.get("/analytics/top-products", response_model=TopProductsResponse)
def get_top_products(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    limit: int = Query(10, le=50),
    user: CurrentUser = Depends(get_current_user),
):
    """Real best-sellers by revenue for Trend Analysis (executive only),
    aggregated from actual transaction_items -- not a canned suggestion
    list."""
    require_role(user, "executive")
    date_from, date_to = _resolve_range(date_from, date_to)

    supabase = get_supabase()
    start, end = _range_bounds(date_from, date_to)
    tx_result = (
        supabase.table("transactions")
        .select("id")
        .gte("opened_at", start)
        .lte("opened_at", end)
        .neq("status", "voided")
        .execute()
    )
    transaction_ids = [t["id"] for t in tx_result.data]
    if not transaction_ids:
        return TopProductsResponse(date_from=date_from, date_to=date_to, products=[])

    items_result = (
        supabase.table("transaction_items")
        .select("quantity, unit_price, product_sizes(product_id, products(name))")
        .in_("transaction_id", transaction_ids)
        .execute()
    )
    agg: dict[str, dict] = defaultdict(lambda: {"name": "", "quantity_sold": 0.0, "revenue": 0.0})
    for item in items_result.data:
        size = item["product_sizes"]
        product_id = size["product_id"]
        agg[product_id]["name"] = size["products"]["name"]
        agg[product_id]["quantity_sold"] += float(item["quantity"])
        agg[product_id]["revenue"] += float(item["quantity"]) * float(item["unit_price"])

    rows = [
        TopProductRow(product_id=pid, product_name=v["name"], quantity_sold=v["quantity_sold"], revenue=v["revenue"])
        for pid, v in agg.items()
    ]
    rows.sort(key=lambda r: r.revenue, reverse=True)

    return TopProductsResponse(date_from=date_from, date_to=date_to, products=rows[:limit])
