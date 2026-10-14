"""Paid-order analytics for the Command Center.

This deliberately leaves the operational dashboard summary unchanged: that
summary includes unpaid orders, while these sales views do not.
"""

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.ph_time import PH_UTC_OFFSET, today_ph
from app.schemas import SalesInsightsResponse

router = APIRouter(tags=["dashboard"])
PH_TZ = timezone(PH_UTC_OFFSET)
PAGE_SIZE = 500
ID_BATCH_SIZE = 100
ORDER_TYPES = ("dine_in", "takeout", "delivery", "unspecified")
SOURCE_NAMES = ("pos", "online", "grab", "qr", "unspecified")


def _period_dates(period: str, anchor: date) -> tuple[date, date]:
    if period == "day":
        return anchor, anchor + timedelta(days=1)
    if period == "week":
        start = anchor - timedelta(days=anchor.weekday())
        return start, start + timedelta(days=7)
    start = anchor.replace(day=1)
    end = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return start, end


def _previous_start(period: str, start: date) -> date:
    if period == "day":
        return start - timedelta(days=1)
    if period == "week":
        return start - timedelta(days=7)
    return (start - timedelta(days=1)).replace(day=1)


def _page_rows(query) -> list[dict]:
    """PostgREST commonly caps a response at 1,000 rows; never truncate sales."""
    rows: list[dict] = []
    offset = 0
    while True:
        page = query.range(offset, offset + PAGE_SIZE - 1).execute().data
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def _transactions(db, start: datetime, end: datetime) -> list[dict]:
    query = (
        db.table("transactions")
        .select("id, opened_at, total_amount, order_type, order_source, payment_method, card_type")
        .gte("opened_at", start.astimezone(timezone.utc).isoformat())
        .lt("opened_at", end.astimezone(timezone.utc).isoformat())
        .neq("status", "voided")
        .eq("payment_status", "paid")
        .order("opened_at")
        .order("id")
    )
    return _page_rows(query)


def _items(db, ids: list[str]) -> list[dict]:
    rows: list[dict] = []
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        batch = ids[offset:offset + ID_BATCH_SIZE]
        query = (
            db.table("transaction_items")
            .select("id, product_size_id, quantity, unit_price, product_sizes(product_id, size_label, products(name, category))")
            .in_("transaction_id", batch)
            .order("id")
        )
        rows.extend(_page_rows(query))
    return rows


def _change(current: float, previous: float) -> float | None:
    return round((current - previous) / previous * 100, 1) if previous else None


def _digital_methods(db, ids: list[str]) -> dict[str, str]:
    methods: dict[str, str] = {}
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        rows = _page_rows(db.table("digital_orders")
                          .select("transaction_id, payment_method")
                          .in_("transaction_id", ids[offset:offset + ID_BATCH_SIZE])
                          .order("transaction_id"))
        methods.update({row["transaction_id"]: row["payment_method"] for row in rows})
    return methods


def _payment_name(row: dict, digital_methods: dict[str, str]) -> str:
    # The digital order retains the actual online provider; its linked
    # transaction may contain the generic legacy value "gcash".
    digital_method = digital_methods.get(row["id"])
    if digital_method:
        return digital_method.lower() if digital_method.lower() in ("cash", "gcash", "maya", "bdo") else digital_method
    method = (row.get("payment_method") or "").lower()
    if method == "card":
        return row.get("card_type") if row.get("card_type") in ("debit", "credit") else "unspecified_card"
    return method or "unspecified"


# The staff count these by size first (manual checking), so they lead
# "Menu category sales" in this order, each across every flavor.
SIZE_GROUPS = ("8pc Maki", "4pc Maki", "Platter", "4pc Takoyaki", "8pc Takoyaki")


def size_group(category: str, size_label: str) -> str | None:
    size = (size_label or "").strip().lower()
    if category == "Oishii Maki Rolls" and size in ("8 pcs", "4 pcs"):
        return f"{size[0]}pc Maki"
    if category == "Oishii Platter (Bundle)":
        return "Platter"
    if category.startswith("Takoyaki (") and size in ("4 pcs", "8 pcs"):
        return f"{size[0]}pc Takoyaki"
    return None


def order_categories(groups) -> list[dict]:
    """Size groups first in SIZE_GROUPS order, then the rest by revenue."""
    groups = list(groups)
    lead = sorted((g for g in groups if g["category"] in SIZE_GROUPS), key=lambda g: SIZE_GROUPS.index(g["category"]))
    rest = sorted((g for g in groups if g["category"] not in SIZE_GROUPS), key=lambda g: (-g["item_revenue"], g["category"]))
    return lead + rest


@router.get("/dashboard/sales-insights", response_model=SalesInsightsResponse)
def get_sales_insights(
    period: Literal["day", "week", "month"] = Query("day"),
    anchor: date | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    require_role_or_grant(user, "command-center", "executive")
    anchor = anchor or today_ph()
    if anchor > today_ph():
        raise HTTPException(status_code=400, detail="Future dates are not available")

    start_date, end_date = _period_dates(period, anchor)
    start = datetime.combine(start_date, time.min, PH_TZ)
    end = datetime.combine(end_date, time.min, PH_TZ)
    now = datetime.now(PH_TZ)
    as_of = min(end, now)

    previous_start_date = _previous_start(period, start_date)
    previous_start = datetime.combine(previous_start_date, time.min, PH_TZ)
    _, previous_end_date = _period_dates(period, previous_start_date)
    previous_end = datetime.combine(previous_end_date, time.min, PH_TZ)
    # Current open periods are compared with the same elapsed part of the
    # previous period; complete periods use the complete previous period.
    comparison_end = min(previous_end, previous_start + (as_of - start)) if as_of < end else previous_end

    db = get_supabase()
    current = _transactions(db, start, as_of)
    previous = _transactions(db, previous_start, comparison_end)
    revenue = sum(float(row["total_amount"]) for row in current)
    previous_revenue = sum(float(row["total_amount"]) for row in previous)

    by_type = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    previous_type = defaultdict(float)
    by_source = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    by_payment = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    by_payment_source = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    hourly = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    series = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})

    for row in previous:
        key = row.get("order_type") or "unspecified"
        previous_type[key if key in ORDER_TYPES else "unspecified"] += float(row["total_amount"])

    digital_methods = _digital_methods(db, [row["id"] for row in current])
    for row in current:
        value = float(row["total_amount"])
        kind = row.get("order_type") or "unspecified"
        kind = kind if kind in ORDER_TYPES else "unspecified"
        source = row.get("order_source") or "unspecified"
        source = source if source in SOURCE_NAMES else "unspecified"
        method = _payment_name(row, digital_methods)
        for target in (by_payment[method], by_payment_source[(source, method)]):
            target["revenue"] += value
            target["order_count"] += 1
        opened = datetime.fromisoformat(row["opened_at"].replace("Z", "+00:00")).astimezone(PH_TZ)
        bucket = opened.strftime("%Y-%m-%dT%H") if period == "day" else opened.date().isoformat()
        for target in (by_type[kind], by_source[source], hourly[opened.hour], series[bucket]):
            target["revenue"] += value
            target["order_count"] += 1

    item_totals: dict[str, dict] = {}
    for item in _items(db, [row["id"] for row in current]):
        size = item.get("product_sizes") or {}
        product = size.get("products") or {}
        product_id = size.get("product_id")
        size_id = item.get("product_size_id")
        if not product_id or not size_id:
            continue
        entry = item_totals.setdefault(size_id, {
            "product_id": product_id,
            "product_size_id": size_id,
            "product_name": product.get("name") or "Unknown item",
            "size_label": size.get("size_label") or "Unspecified size",
            "category": product.get("category") or "Uncategorized",
            "quantity_sold": 0.0,
            "item_revenue": 0.0,
        })
        quantity = float(item["quantity"])
        entry["quantity_sold"] += quantity
        entry["item_revenue"] += quantity * float(item["unit_price"])

    categories: dict[str, dict] = {}
    for item in item_totals.values():
        name = size_group(item["category"], item["size_label"]) or item["category"]
        group = categories.setdefault(name, {
            "category": name, "quantity_sold": 0.0, "item_revenue": 0.0, "items": []
        })
        group["quantity_sold"] += item["quantity_sold"]
        group["item_revenue"] += item["item_revenue"]
        group["items"].append(item)
    for group in categories.values():
        group["items"].sort(key=lambda item: (-item["item_revenue"], item["product_name"], item["size_label"]))

    points = []
    cursor = start
    step = timedelta(hours=1) if period == "day" else timedelta(days=1)
    while cursor < as_of:
        key = cursor.strftime("%Y-%m-%dT%H") if period == "day" else cursor.date().isoformat()
        totals = series[key]
        points.append({"bucket": key, **totals})
        cursor += step

    peak_hour = max(hourly, key=lambda hour: hourly[hour]["revenue"]) if hourly else None
    return SalesInsightsResponse(
        period=period,
        anchor=anchor,
        period_start=start,
        period_end=end,
        as_of=as_of,
        comparison_start=previous_start,
        comparison_end=comparison_end,
        revenue=revenue,
        order_count=len(current),
        average_order_value=revenue / len(current) if current else 0,
        previous_revenue=previous_revenue,
        previous_order_count=len(previous),
        revenue_change_pct=_change(revenue, previous_revenue),
        by_order_type=[{
            "order_type": kind,
            "revenue": by_type[kind]["revenue"],
            "order_count": by_type[kind]["order_count"],
            "average_order_value": by_type[kind]["revenue"] / by_type[kind]["order_count"] if by_type[kind]["order_count"] else 0,
            "share_pct": by_type[kind]["revenue"] / revenue * 100 if revenue else 0,
            "previous_revenue": previous_type[kind],
            "change_pct": _change(by_type[kind]["revenue"], previous_type[kind]),
        } for kind in ORDER_TYPES],
        by_order_source=[{"order_source": source, **by_source[source]} for source in SOURCE_NAMES],
        by_payment_method=[{"payment_method": method, **totals} for method, totals in sorted(by_payment.items())],
        by_payment_source=[{"order_source": source, "payment_method": method, **totals}
                           for (source, method), totals in sorted(by_payment_source.items())],
        series=points,
        categories=order_categories(categories.values()),
        peak_hour=peak_hour,
    )
