"""Executive-only Profit & Loss dashboard: rolls up revenue, COGS, payroll,
utilities, and losses for a rolling Today/Week/Month window.

COGS is computed live at report time by re-joining the existing recipe/BOM
data (recipe_items for regular items, bundle_fulfillments for bundle items)
against ingredients.unit_cost -- deliberately not a new BOM schema, and not
a precomputed/cached snapshot table, since this build is single-location at
a scale where a live query is simple and fast enough (matches Command
Center's/Trend Analysis's own live-query approach).

JUDGMENT CALL: ingredients.unit_cost is "most-recent-cost" only (see
migration 0021) -- there is no per-sale cost snapshot anywhere in this
schema (sales only ever mutate ingredients.current_stock, never write
inventory_movements or freeze a cost). A COGS figure for a past period
therefore reflects TODAY's ingredient costs, not what was actually in
effect on the sale date. This is an accepted, inherent limitation of the
existing cost-tracking design, not something this endpoint works around.
"""

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.routers.analytics import _range_bounds
from app.routers.hr import _compute_payroll_summary
from app.routers.transactions import _bundle_fulfillments_supported_check
from app.schemas import (
    PnLCostBreakdown,
    PnLDepartmentMargin,
    PnLLossByReason,
    PnLPeriod,
    PnLResponse,
)

router = APIRouter(tags=["pnl"])


def _resolve_period_range(period: PnLPeriod) -> tuple[date, date]:
    today = date.today()
    if period == "today":
        return today, today
    if period == "week":
        return today - timedelta(days=6), today
    return today - timedelta(days=29), today  # "month" -- 30-day rolling window


@router.get("/pnl", response_model=PnLResponse)
def get_pnl(period: PnLPeriod = Query("today"), user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "pnl", "executive")
    supabase = get_supabase()
    date_from, date_to = _resolve_period_range(period)
    start, end = _range_bounds(date_from, date_to)

    # --- Revenue / discount / tax / order_count -- same filter as
    # dashboard_summary.py/analytics.py ---
    tx_result = (
        supabase.table("transactions")
        .select("id, total_amount, discount_amount, tax_amount")
        .gte("opened_at", start)
        .lte("opened_at", end)
        .neq("status", "voided")
        .execute()
    )
    transactions = tx_result.data
    revenue = sum(float(t["total_amount"]) for t in transactions)
    discount_total = sum(float(t["discount_amount"]) for t in transactions)
    tax_total = sum(float(t["tax_amount"]) for t in transactions)
    order_count = len(transactions)
    transaction_ids = [t["id"] for t in transactions]

    # --- transaction_items -- split bundle vs non-bundle, track item revenue
    # by department (same attribution dashboard_summary.py already uses: the
    # sold line's own product/department, not its components) ---
    items_by_dept_revenue: dict[str, float] = defaultdict(float)
    non_bundle_items: list[tuple[str, float, str]] = []  # (product_size_id, quantity, department)
    bundle_items: list[tuple[str, str]] = []  # (transaction_item_id, department)
    if transaction_ids:
        items = (
            supabase.table("transaction_items")
            .select(
                "id, quantity, unit_price, product_size_id, "
                "product_sizes(product_id, products(department, is_bundle))"
            )
            .in_("transaction_id", transaction_ids)
            .execute()
            .data
        )
        for it in items:
            product = it["product_sizes"]["products"]
            dept = product["department"]
            items_by_dept_revenue[dept] += float(it["unit_price"]) * float(it["quantity"])
            if product["is_bundle"]:
                bundle_items.append((it["id"], dept))
            else:
                non_bundle_items.append((it["product_size_id"], float(it["quantity"]), dept))

    # --- Bundle fulfillment lookup -- unfulfilled count + roll->size
    # resolution (mirrors transactions.py's own bundle-fulfillment/void
    # logic: a roll product resolves to exactly one product_size) ---
    size_ids = {s for s, _, _ in non_bundle_items}
    bundle_item_ids = [iid for iid, _ in bundle_items]
    fulfillment_rows: list[dict] = []
    fulfilled_item_ids: set[str] = set()
    roll_size_by_product: dict[str, str] = {}
    if bundle_item_ids and _bundle_fulfillments_supported_check(supabase):
        fulfillment_rows = (
            supabase.table("bundle_fulfillments")
            .select("transaction_item_id, maki_roll_product_id, quantity")
            .in_("transaction_item_id", bundle_item_ids)
            .execute()
            .data
        )
        fulfilled_item_ids = {r["transaction_item_id"] for r in fulfillment_rows}
        roll_product_ids = list({r["maki_roll_product_id"] for r in fulfillment_rows})
        if roll_product_ids:
            roll_sizes = (
                supabase.table("product_sizes")
                .select("id, product_id")
                .in_("product_id", roll_product_ids)
                .execute()
                .data
            )
            roll_size_by_product = {r["product_id"]: r["id"] for r in roll_sizes}
            size_ids |= set(roll_size_by_product.values())
    unfulfilled_bundle_sales = sum(1 for iid, _ in bundle_items if iid not in fulfilled_item_ids)

    # --- One batched recipe_items query across every size in play (regular
    # items' own sizes + resolved bundle-roll sizes) -- avoids N+1 ---
    recipe_cost_by_size: dict[str, float] = defaultdict(float)  # cost of one serving of this size
    if size_ids:
        recipe_rows = (
            supabase.table("recipe_items")
            .select("product_size_id, qty_per_serving, ingredients(unit_cost)")
            .in_("product_size_id", list(size_ids))
            .execute()
            .data
        )
        for row in recipe_rows:
            unit_cost = row["ingredients"]["unit_cost"] if row["ingredients"] else None
            if unit_cost is None:
                continue  # needs-costing ingredient -- contributes $0, surfaced via ingredients_missing_cost
            recipe_cost_by_size[row["product_size_id"]] += float(row["qty_per_serving"]) * float(unit_cost)

    # --- COGS by department ---
    cogs_by_dept: dict[str, float] = defaultdict(float)
    for size_id, qty, dept in non_bundle_items:
        cogs_by_dept[dept] += recipe_cost_by_size.get(size_id, 0.0) * qty
    bundle_dept_by_item = dict(bundle_items)
    for row in fulfillment_rows:
        size_id = roll_size_by_product.get(row["maki_roll_product_id"])
        if size_id is None:
            continue
        dept = bundle_dept_by_item.get(row["transaction_item_id"], "kitchen")
        cogs_by_dept[dept] += recipe_cost_by_size.get(size_id, 0.0) * float(row["quantity"])
    cogs_total = sum(cogs_by_dept.values())

    # --- Payroll -- live aggregator, gross wages only (no statutory
    # contributions exist anywhere in this schema) ---
    payroll_summary = _compute_payroll_summary(supabase, date_from, date_to)
    payroll_total = payroll_summary["total_pay"]

    # --- Utilities -- range-filtered version of dashboard_summary.py's
    # inline formula; deliberately no days_covered apportionment, matching
    # that endpoint's existing (accepted) behavior ---
    utility_rows = (
        supabase.table("utility_logs")
        .select("reading_start, reading_end, quantity, unit_cost")
        .gte("business_date", date_from.isoformat())
        .lte("business_date", date_to.isoformat())
        .execute()
        .data
    )
    utility_total = 0.0
    for log in utility_rows:
        if log["reading_end"] is not None and log["reading_start"] is not None:
            consumption = float(log["reading_end"]) - float(log["reading_start"])
        elif log["quantity"] is not None:
            consumption = float(log["quantity"])
        else:
            continue
        utility_total += consumption * float(log["unit_cost"])

    # --- Losses -- own P&L line, never netted into COGS ---
    loss_rows = (
        supabase.table("loss_records")
        .select("reason, cost_impact")
        .gte("created_at", start)
        .lte("created_at", end)
        .execute()
        .data
    )
    loss_by_reason: dict[str, float] = defaultdict(float)
    for r in loss_rows:
        loss_by_reason[r["reason"]] += float(r["cost_impact"])
    loss_total = sum(loss_by_reason.values())

    # --- Needs-costing nudge -- global count, not scoped to this period ---
    ingredients = supabase.table("ingredients").select("id, unit_cost").execute().data
    ingredients_total = len(ingredients)
    ingredients_missing_cost = sum(1 for i in ingredients if i["unit_cost"] is None)

    gross_profit = revenue - cogs_total
    net_profit = gross_profit - payroll_total - utility_total - loss_total
    food_cost_pct = (cogs_total / revenue) if revenue > 0 else None

    dept_keys = set(items_by_dept_revenue) | set(cogs_by_dept)
    department_margins = [
        PnLDepartmentMargin(
            department=d,
            revenue=items_by_dept_revenue.get(d, 0.0),
            cogs=cogs_by_dept.get(d, 0.0),
            margin=items_by_dept_revenue.get(d, 0.0) - cogs_by_dept.get(d, 0.0),
            margin_pct=(
                (items_by_dept_revenue[d] - cogs_by_dept.get(d, 0.0)) / items_by_dept_revenue[d]
                if items_by_dept_revenue.get(d, 0.0) > 0
                else None
            ),
        )
        for d in dept_keys
    ]

    return PnLResponse(
        period=period,
        date_from=date_from,
        date_to=date_to,
        revenue=revenue,
        discount_total=discount_total,
        tax_total=tax_total,
        order_count=order_count,
        gross_profit=gross_profit,
        net_profit=net_profit,
        food_cost_pct=food_cost_pct,
        costs=PnLCostBreakdown(
            cogs=cogs_total, payroll=payroll_total, utilities=utility_total, losses=loss_total
        ),
        losses_by_reason=[PnLLossByReason(reason=r, cost_impact=c) for r, c in loss_by_reason.items()],
        department_margins=department_margins,
        ingredients_missing_cost=ingredients_missing_cost,
        ingredients_total=ingredients_total,
        unfulfilled_bundle_sales=unfulfilled_bundle_sales,
        payroll_employee_count=payroll_summary["employee_count"],
    )
