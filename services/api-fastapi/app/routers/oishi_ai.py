import json
import os
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from openai import OpenAI

from app.attendance_utils import hr_table
from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.ph_time import ph_day_bounds_utc
from app.routers.analytics import get_sales_trend, get_top_products
from app.routers.dashboard_summary import get_dashboard_summary
from app.routers.hr import _compute_payroll_summary
from app.routers.pnl import get_pnl
from app.routers.settings import get_business_settings
from app.routers.stock_items import get_low_stock_stock_items
from app.schemas import OishiAiQueryRequest, OishiAiQueryResponse

router = APIRouter(tags=["oishi-ai"])

# Groq (OpenAI-compatible endpoint) -- switched from xAI/Grok since that
# account had no billing set up. llama-3.3-70b-versatile (the model the
# SMFC reference's Malaya AI uses) has since been retired from Groq's
# lineup. The free/on-demand tier's 8000 TPM cap is per-organization,
# not per-model, so model size doesn't buy headroom directly -- but the
# smaller openai/gpt-oss-20b (vs. -120b) still answers this app's
# grounded-JSON-lookup task perfectly well and leaves more margin for
# the ~6-7k token context payload (see _inventory_analysis's comment on
# why all_ingredients was trimmed down to fit under this cap).
GROQ_MODEL = "openai/gpt-oss-20b"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

SYSTEM_PROMPT = """You are Oishii AI, the AI business analyst for Oishii Nori,
a single-location sushi/cafe restaurant. You answer questions using ONLY the
JSON data block provided in the user message -- never invent numbers that
aren't in that data. If the data doesn't cover what was asked, say so plainly
instead of guessing.

Keep answers conversational and short (2-4 sentences), like a sharp analyst
briefing a busy manager, not a report. All monetary figures in the data are
Philippine pesos -- write them like "₱2,505.00", not a bare number.

Respond with a JSON object with exactly these keys:
- "answer": string, your response in plain language.
- "chart": either null, or an object shaped like
  {"type": "bar" | "line", "title": string,
   "series": [{"name": string, "data": [{"label": string, "value": number}, ...]}]}
  Only include a chart when the question implies a comparison, trend, or
  breakdown (e.g. "show revenue by day", "what's my biggest cost driver") --
  for a simple factual question, chart should be null.

DATA FIELD GUIDE -- match the question to the right field before answering,
don't guess from the wrong one:
- todays_summary: revenue/discounts/tax/loss/utility-cost/low-stock for
  TODAY ONLY (date field in this object).
- top_products_today: units sold/revenue today per product, ranked by
  revenue descending. Use for "what's my best seller today" / "what's
  trending right now" -- today's sales only.
- top_products_30d: same shape as top_products_today but ranked over the
  trailing 30 days -- use for "what's my best seller" / "what sells best
  overall" when the question doesn't specifically say "today".
- loss_analysis.accumulated_loss_total: total cost of EVERY loss ever
  logged (all-time, not just today) -- use this for "accumulated loss" /
  "total loss" / "how much have we lost overall" questions.
- loss_analysis.top_loss_item: the single ingredient responsible for the
  most cumulative loss cost across all logged losses -- use this to answer
  "what item generates the most loss", "biggest source of waste", etc. It
  already IS the answer; don't recompute it from recent_losses (incomplete,
  just the 5 most recent rows).
- loss_analysis.by_reason: total loss cost grouped by cause (spoilage,
  breakage, comp, prep_error, shrinkage) -- use for "why are we losing
  money", "what's our biggest loss category", or "how much have we lost to
  spoilage" style questions (look up the "spoilage" key specifically for
  that last one).
- recent_losses: the 5 most recent individual loss log entries, for
  "what was just logged" / recency-style questions -- not a complete
  all-time picture. Compact array, no key names -- each row is
  [ingredient, reason, quantity, cost_impact, logged_at] in that exact
  order, match by position.
- payroll_analysis: aggregate payroll for the CURRENT semimonthly pay
  period only (see period_start/period_end in this field) --
  total_payroll_cost, total_hours, employee_count. Use
  top_overtime_holiday_driver for "who's costing the most in OT/holiday
  pay this period" questions.
- payroll_history: up to the last 5 generated payroll runs, most recent
  first -- use for "how much did we spend on payroll last month/period" or
  any historical/period-over-period payroll question that payroll_analysis
  (current period only) can't answer. If the period asked about isn't in
  this list, say so rather than guessing. Compact array, no key names --
  each row is [period_start, period_end, total_hours, total_pay,
  employee_count, created_at] in that exact order, match by position.
- employee_roster: every employee's full_name, role, department,
  position, pay_rate, employee_number -- use for "what's X's pay rate",
  "how many employees do we have", "who works in kitchen vs cafe", or any
  named-employee question. pay_rate is per hour in PHP. This is the only
  source of individual compensation figures -- never estimate a person's
  pay from payroll_analysis or payroll_history, which are aggregates only.
- sales_trend_30d.daily_revenue: revenue per calendar day for the last 30
  days -- use for daily trend / week-over-week charting questions.
- revenue_totals.this_week / this_month / all_time: revenue + order_count
  totals for those windows -- use for "how are we doing this month",
  "total revenue all-time", or any non-daily revenue-window question
  sales_trend_30d's daily granularity isn't suited for.
- inventory_analysis.all_ingredients: every ingredient's name and current
  stock -- use this for "what's my current stock of X" for ANY ingredient,
  not just ones running low. Compact array, no key names -- each row is
  [name, stock] where stock is already a "quantity unit" string (e.g.
  "500 g"), match by position. It does NOT carry category,
  reorder_threshold, or needs_review -- category breakdowns come from
  by_category (aggregate counts only, not per-ingredient), and
  reorder_threshold/needs_review are only on low_stock_items /
  needs_review_count. There is no cost/valuation figure for inventory in
  this data -- don't invent one (see pnl_summary for the real, computed
  cost figures that do exist).
- inventory_analysis.low_stock_items / low_stock_count: ingredients at or
  below their reorder threshold, worst shortage first, capped at 15 rows
  (low_stock_count is the true total even if the list is capped) -- use
  for "what needs restocking" questions specifically. This is for RECIPE
  INGREDIENTS only -- see stock_items_analysis for the separate
  packaging/supplies/resale-beverage catalog.
- inventory_analysis.by_category / total_ingredient_count /
  needs_review_count: use for "how many ingredients do we stock", "what
  needs review", or category-breakdown questions. If asked what category a
  SPECIFIC ingredient is in, say that level of detail isn't available --
  only aggregate counts per category exist in this data.
- recent_inventory_movements: last 5 stock movements (delivery, transfer,
  count adjustment, etc.) -- use for "what was just received/adjusted"
  questions. Compact array, no key names -- each row is
  [ingredient, type, quantity, reason, employee, logged_at] in that exact
  order, match by position.
- discount_types: currently active discounts (name, percentage,
  vat_exempt) -- use for "what discounts do we offer" questions.
- digital_orders_summary: count of QR/digital-menu orders by status
  (pending/approved/rejected), all-time -- use for "how many online
  orders are pending/have we gotten" questions.
- utility_cost_by_type_30d: utility cost (electricity/water/gas) summed
  over the trailing 30 days -- use for "what's our biggest utility cost"
  or utility-spend questions beyond just today (todays_summary has
  today's utility cost only).
- pnl_summary.week / pnl_summary.month: real computed revenue, gross/net
  profit, food_cost_pct, and a cost breakdown (cogs/payroll/utilities/
  losses) for a trailing-7-day ("week") or trailing-30-day ("month")
  rolling window (see each's own date_from/date_to) -- use for "what's my
  food cost percentage", "how profitable are we", "what's our margin by
  department" questions. IMPORTANT LIMITATION: cogs/food_cost_pct are
  computed using TODAY's ingredient unit_cost applied retroactively across
  the whole window -- there is no per-sale historical cost snapshot in
  this schema, so a week-old food cost % reflects current ingredient
  pricing, not what was actually in effect on that sale date. Say so
  rather than implying precision if asked about historical cost accuracy.
  ingredients_missing_cost / ingredients_total show how many ingredients
  have no unit_cost set at all (their COGS contributes ₱0, which
  understates cogs) -- mention this if food_cost_pct looks surprisingly
  low. department_margins only ever has up to 2 entries (kitchen, cafe --
  this restaurant's only departments). Don't answer profit/margin/COGS
  questions from todays_summary or revenue_totals -- neither has any cost
  or profit figure.
- stock_items_analysis: aggregate counts for the separate station-based
  stock catalog (packaging, supplies, and resale beverages tracked per
  station -- tako_snack/cafe_drinks/sushi_kitchen_main/ramen_hot_line) -- a
  DIFFERENT table from inventory_analysis's recipe ingredients, don't mix
  the two up. needs_review_count is how many station items are flagged
  for manual verification. low_stock_items/low_stock_count mirror
  inventory_analysis's low-stock shape but for this catalog specifically
  (list capped at 8, count is the true total) -- use for "how many station
  items need verification/restocking" questions. There is no variance/
  count-discrepancy data in this context (that only lives in the Variance
  Log page's UI) -- say so if asked about count discrepancies rather than
  guessing from low_stock_items.
- business_settings.vat_rate: the current admin-configured VAT rate (e.g.
  0.12 = 12%) applied to new sales -- use for "what's our VAT rate"
  questions. This is the live rate right now, not necessarily what applied
  to a past transaction -- the rate is admin-editable and this data has no
  history of past values.
- menu_catalog: aggregate snapshot of the live product catalog (products +
  their sizes/prices) -- total_products/active_count/inactive_count,
  by_department, by_category, price_range (cheapest and priciest active
  size), and top_5_most_expensive -- use for "what's my most expensive/
  cheapest menu item", "how many products are active", "how many
  categories do we sell" questions. This is catalog PRICING, not sales
  performance -- for what actually sells, use top_products_today/
  top_products_30d instead, never infer popularity from price.
- menu_addons: currently active digital-menu add-ons (name, price) -- use
  for "what add-ons do we offer" questions. Bundle-fulfillment status
  (unfulfilled maki-roll counts awaiting kitchen fulfillment) lives in
  pnl_summary.week/month's unfulfilled_bundle_sales field, not here --
  there is no all-time/current-backlog bundle-fulfillment count in this
  data, only the per-period P&L figures.
"""


def _top_products(user: CurrentUser, date_from: date, date_to: date, limit: int = 5) -> list[dict]:
    result = get_top_products(date_from=date_from, date_to=date_to, limit=limit, user=user)
    return [
        {"product": p.product_name, "units_sold": p.quantity_sold, "revenue": p.revenue}
        for p in result.products
    ]


def _employee_roster(supabase) -> list[dict]:
    result = (
        supabase.table("profiles")
        .select("full_name, role, department, position, pay_rate, employee_number")
        .order("full_name")
        .execute()
    )
    return result.data


def _payroll_history(limit: int = 5) -> list[list]:
    """Compact [period_start, period_end, total_hours, total_pay,
    employee_count, created_at] rows instead of dicts -- the repeated key
    names across every row were a real, measured token cost once
    pnl_summary/stock_items_analysis/menu_catalog/menu_addons were added
    (see the Groq TPM cap note on GROQ_MODEL above); the DATA FIELD GUIDE
    documents the column order for the model."""
    result = (
        hr_table("payroll_records")
        .select("period_start, period_end, total_hours, total_pay, employee_count, created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return [
        [r["period_start"], r["period_end"], r["total_hours"], r["total_pay"], r["employee_count"], r["created_at"]]
        for r in result.data
    ]


def _recent_inventory_movements(supabase, limit: int = 5) -> list[list]:
    result = (
        supabase.table("inventory_movements")
        .select("ingredient_id, type, quantity, reason, employee_id, created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    rows = result.data
    if not rows:
        return []

    ingredient_ids = {r["ingredient_id"] for r in rows}
    employee_ids = {r["employee_id"] for r in rows if r.get("employee_id")}
    ingredients_result = supabase.table("ingredients").select("id, name").in_("id", list(ingredient_ids)).execute()
    name_by_ingredient = {i["id"]: i["name"] for i in ingredients_result.data}
    name_by_employee: dict[str, str] = {}
    if employee_ids:
        employees_result = supabase.table("profiles").select("id, full_name").in_("id", list(employee_ids)).execute()
        name_by_employee = {e["id"]: e["full_name"] for e in employees_result.data}

    return [
        [
            name_by_ingredient.get(r["ingredient_id"], "Unknown"),
            r["type"],
            r["quantity"],
            r.get("reason"),
            name_by_employee.get(r["employee_id"]) if r.get("employee_id") else None,
            r["created_at"],
        ]
        for r in rows
    ]


def _revenue_bucket(supabase, since: date | None) -> dict:
    query = supabase.table("transactions").select("total_amount, is_owner_request").neq("status", "voided")
    if since is not None:
        start, _ = ph_day_bounds_utc(since)
        query = query.gte("opened_at", start)
    result = query.execute()
    rows = [r for r in result.data if not r.get("is_owner_request")]
    return {"revenue": round(sum(float(r["total_amount"]) for r in rows), 2), "order_count": len(rows)}


def _revenue_totals(supabase) -> dict:
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    month_start = today.replace(day=1)
    return {
        "this_week": _revenue_bucket(supabase, week_start),
        "this_month": _revenue_bucket(supabase, month_start),
        "all_time": _revenue_bucket(supabase, None),
    }


def _discount_types(supabase) -> list[dict]:
    result = (
        supabase.table("discount_types")
        .select("name, percentage, vat_exempt")
        .eq("active", True)
        .execute()
    )
    return result.data


def _digital_orders_summary(supabase) -> dict:
    result = supabase.table("digital_orders").select("status").execute()
    counts: dict[str, int] = defaultdict(int)
    for row in result.data:
        counts[row["status"]] += 1
    return dict(counts)


def _utility_cost_by_type_30d(supabase) -> dict:
    today = date.today()
    start = today - timedelta(days=29)
    result = (
        supabase.table("utility_logs")
        .select("utility_type, reading_start, reading_end, quantity, unit_cost")
        .gte("business_date", start.isoformat())
        .lte("business_date", today.isoformat())
        .execute()
    )
    by_type: dict[str, float] = defaultdict(float)
    for log in result.data:
        if log["reading_end"] is not None and log["reading_start"] is not None:
            consumption = float(log["reading_end"]) - float(log["reading_start"])
        elif log["quantity"] is not None:
            consumption = float(log["quantity"])
        else:
            consumption = None
        if consumption is not None:
            by_type[log["utility_type"]] += consumption * float(log["unit_cost"])
    return {k: round(v, 2) for k, v in by_type.items()}


def _recent_losses(supabase, limit: int = 5) -> list[list]:
    losses_result = (
        supabase.table("loss_records")
        .select("ingredient_id, reason, quantity, cost_impact, created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    rows = losses_result.data
    if not rows:
        return []

    ingredient_ids = {r["ingredient_id"] for r in rows}
    ingredients_result = supabase.table("ingredients").select("id, name").in_("id", list(ingredient_ids)).execute()
    name_by_id = {i["id"]: i["name"] for i in ingredients_result.data}

    return [
        [name_by_id.get(r["ingredient_id"], "Unknown"), r["reason"], r["quantity"], r["cost_impact"], r["created_at"]]
        for r in rows
    ]


def _loss_analysis(supabase) -> dict:
    """All-time loss aggregation -- the deterministic 'harness' that answers
    accumulated-loss and biggest-loss-driver questions correctly instead of
    leaving the LLM to guess from a partial recent-losses list."""
    losses_result = supabase.table("loss_records").select("ingredient_id, reason, cost_impact").execute()
    rows = losses_result.data
    if not rows:
        return {"accumulated_loss_total": 0, "top_loss_item": None, "by_reason": {}}

    total = sum(float(r["cost_impact"]) for r in rows)

    cost_by_ingredient: dict[str, float] = defaultdict(float)
    cost_by_reason: dict[str, float] = defaultdict(float)
    for r in rows:
        cost_by_ingredient[r["ingredient_id"]] += float(r["cost_impact"])
        cost_by_reason[r["reason"]] += float(r["cost_impact"])

    top_ingredient_id, top_cost = max(cost_by_ingredient.items(), key=lambda kv: kv[1])
    ingredient_result = (
        supabase.table("ingredients").select("name").eq("id", top_ingredient_id).maybe_single().execute()
    )
    top_name = ingredient_result.data["name"] if ingredient_result and ingredient_result.data else "Unknown"

    return {
        "accumulated_loss_total": round(total, 2),
        "top_loss_item": {"ingredient": top_name, "total_cost": round(top_cost, 2)},
        "by_reason": {reason: round(cost, 2) for reason, cost in cost_by_reason.items()},
    }


def _current_semimonthly_period(today: date | None = None) -> tuple[date, date]:
    """PH payroll runs semimonthly (1st-15th, 16th-end of month) -- same
    cadence the DOLE holiday-pay engine and HR Payroll page already assume."""
    today = today or date.today()
    if today.day <= 15:
        return today.replace(day=1), today.replace(day=15)
    start = today.replace(day=16)
    next_month = (today.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start, next_month - timedelta(days=1)


def _payroll_analysis(supabase) -> dict:
    """Aggregate-only payroll context for the current pay period -- not a
    per-employee dump (see top_overtime_holiday_driver) so individual
    compensation figures don't flow into the LLM prompt/logs beyond one
    named driver."""
    period_start, period_end = _current_semimonthly_period()
    summary = _compute_payroll_summary(supabase, period_start, period_end)

    top_driver = None
    top_extra = -1.0
    for row in summary["rows"]:
        extra = float(row.get("overtime_pay") or 0) + float(row.get("holiday_pay") or 0)
        if extra > top_extra:
            top_extra = extra
            top_driver = {"employee_name": row["employee_name"], "extra_pay": round(extra, 2)}
    if top_driver and top_extra <= 0:
        top_driver = None

    return {
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "total_payroll_cost": summary["total_pay"],
        "total_hours": summary["total_hours"],
        "employee_count": summary["employee_count"],
        "top_overtime_holiday_driver": top_driver,
    }


def _inventory_analysis(supabase, low_stock_limit: int = 15) -> dict:
    """Full inventory picture, not just low-stock -- at ~70-100 ingredients
    for a single-location restaurant, sending the whole list is small
    enough to just include, so "what's my stock of X" works for any
    ingredient. No unit_cost column exists on ingredients in this schema
    (see loss_records.py), so unlike the SMFC reference there is no
    total-valuation figure here."""
    ingredients_result = (
        supabase.table("ingredients")
        .select("name, category, base_unit, current_stock, reorder_threshold, needs_review")
        .execute()
    )
    rows = ingredients_result.data

    low_stock = [r for r in rows if float(r["current_stock"]) <= float(r["reorder_threshold"])]
    low_stock.sort(key=lambda r: float(r["current_stock"]) - float(r["reorder_threshold"]))

    by_category: dict[str, int] = defaultdict(int)
    for r in rows:
        by_category[r.get("category") or "Uncategorized"] += 1

    return {
        "total_ingredient_count": len(rows),
        "needs_review_count": sum(1 for r in rows if r.get("needs_review")),
        "by_category": dict(by_category),
        "low_stock_count": len(low_stock),
        "low_stock_items": [
            {
                "ingredient": r["name"],
                "unit": r["base_unit"],
                "current_stock": r["current_stock"],
                "reorder_threshold": r["reorder_threshold"],
            }
            for r in low_stock[:low_stock_limit]
        ],
        # Deliberately terse -- a compact [name, stock] array, not a dict --
        # this list alone was over half the total context payload at full
        # width (73 rows) even after an earlier trim from 6 to 3 fields, and
        # further headroom was needed for pnl_summary/stock_items_analysis/
        # menu_catalog/menu_addons/business_settings additions. category was
        # dropped (per-ingredient category lookup is no longer answerable
        # from this field; use by_category for aggregate counts instead),
        # and the remaining 2 fields were switched from a dict (repeated
        # "ingredient"/"stock" keys on every row) to a bare 2-element array
        # -- measured ~440 fewer tokens at 73 rows for identical data.
        # reorder_threshold/needs_review stay available via
        # low_stock_items/needs_review_count for the rows that need them.
        "all_ingredients": [
            [r["name"], f"{r['current_stock']} {r['base_unit']}"]
            for r in rows
        ],
    }


def _pnl_summary(user: CurrentUser) -> dict:
    """Slim week/month P&L snapshots, reusing pnl.py's own live COGS/margin
    computation directly rather than duplicating it. "today" is deliberately
    skipped -- todays_summary already covers today's revenue/discount/tax/
    loss, and a single day's food-cost % is too noisy to be useful."""

    def _slim(p) -> dict:
        return {
            "date_from": p.date_from.isoformat(),
            "date_to": p.date_to.isoformat(),
            "revenue": p.revenue,
            "gross_profit": p.gross_profit,
            "net_profit": p.net_profit,
            "food_cost_pct": p.food_cost_pct,
            "cogs": p.costs.cogs,
            "payroll": p.costs.payroll,
            "utilities": p.costs.utilities,
            "losses": p.costs.losses,
            "ingredients_missing_cost": p.ingredients_missing_cost,
            "ingredients_total": p.ingredients_total,
            "unfulfilled_bundle_sales": p.unfulfilled_bundle_sales,
            "department_margins": [
                {"department": d.department, "margin_pct": d.margin_pct} for d in p.department_margins
            ],
        }

    return {
        "week": _slim(get_pnl(period="week", user=user)),
        "month": _slim(get_pnl(period="month", user=user)),
    }


def _stock_items_analysis(supabase, low_stock_limit: int = 8) -> dict:
    """Aggregate-only picture of the separate station-based stock catalog
    (packaging/supplies/resale beverages, stock_items table) -- a different
    table from ingredients/inventory_analysis above. Reuses
    get_low_stock_stock_items (stock_items.py) for the low-stock list rather
    than re-querying reorder logic here."""
    rows = (
        supabase.table("stock_items")
        .select("station, needs_review")
        .eq("active", True)
        .execute()
        .data
    )
    by_station: dict[str, int] = defaultdict(int)
    for r in rows:
        by_station[r["station"]] += 1

    low_stock = get_low_stock_stock_items(supabase)
    low_stock.sort(key=lambda i: i.current_stock - i.reorder_threshold)

    return {
        "total_active_items": len(rows),
        "needs_review_count": sum(1 for r in rows if r.get("needs_review")),
        "by_station": dict(by_station),
        "low_stock_count": len(low_stock),
        "low_stock_items": [
            {
                "name": i.name,
                "station": i.station,
                "current_stock": i.current_stock,
                "reorder_threshold": i.reorder_threshold,
                "unit": i.unit,
            }
            for i in low_stock[:low_stock_limit]
        ],
    }


def _business_settings_summary(user: CurrentUser) -> dict:
    settings = get_business_settings(user=user)
    return {"vat_rate": settings["vat_rate"]}


def _menu_catalog_analysis(supabase) -> dict:
    """Catalog PRICING snapshot -- not sales performance (see top_products_*
    for what actually sells). Deliberately a fresh, minimal query rather
    than reusing products.py's _list_products_data, which also runs an
    extra ingredient-availability join irrelevant to these aggregate stats."""
    products = supabase.table("products").select("id, name, category, department, active").execute().data
    active_ids = {p["id"] for p in products if p["active"]}
    name_by_id = {p["id"]: p["name"] for p in products}

    sizes = supabase.table("product_sizes").select("product_id, size_label, price").execute().data
    active_sizes = [s for s in sizes if s["product_id"] in active_ids]

    by_category: dict[str, int] = defaultdict(int)
    by_department: dict[str, int] = defaultdict(int)
    for p in products:
        by_category[p.get("category") or "Uncategorized"] += 1
        by_department[p.get("department") or "Unassigned"] += 1

    def _fmt(s: dict) -> dict:
        return {"product": name_by_id.get(s["product_id"], "Unknown"), "size": s["size_label"], "price": s["price"]}

    result = {
        "total_products": len(products),
        "active_count": len(active_ids),
        "inactive_count": len(products) - len(active_ids),
        "by_department": dict(by_department),
        "by_category": dict(by_category),
        "price_range": None,
        "top_5_most_expensive": [],
    }
    if active_sizes:
        active_sizes.sort(key=lambda s: float(s["price"]))
        result["price_range"] = {"cheapest": _fmt(active_sizes[0]), "priciest": _fmt(active_sizes[-1])}
        top5 = sorted(active_sizes, key=lambda s: float(s["price"]), reverse=True)[:5]
        result["top_5_most_expensive"] = [_fmt(s) for s in top5]
    return result


def _menu_addons(supabase) -> list[dict]:
    result = supabase.table("menu_addons").select("name, price").eq("active", True).order("name").execute()
    return result.data


@router.post("/ai/query", response_model=OishiAiQueryResponse)
def query_oishi_ai(body: OishiAiQueryRequest, user: CurrentUser = Depends(get_current_user)):
    # Executive-only: the context this endpoint aggregates (dashboard
    # summary, sales trend, top products) is itself executive-gated
    # elsewhere in this app (Oishii is single-location, unlike the SMFC
    # reference's manager-scoped-to-own-branch model), so there is no
    # narrower scope a manager could safely see here anyway.
    require_role(user, "executive")

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Oishii AI isn't configured (missing GROQ_API_KEY)")

    supabase = get_supabase()

    # on_date/date_from/date_to must be passed explicitly here: FastAPI's
    # Query(None, ...) default is a FieldInfo marker resolved to None only
    # via request-time dependency injection, not when called as a plain
    # Python function the way this router calls it.
    today = date.today()
    todays_summary = get_dashboard_summary(on_date=None, user=user).model_dump(mode="json")
    sales_trend_30d = get_sales_trend(date_from=None, date_to=None, user=user).model_dump(mode="json")

    context = {
        "todays_summary": todays_summary,
        "top_products_today": _top_products(user, today, today, limit=5),
        "top_products_30d": _top_products(user, today - timedelta(days=29), today, limit=10),
        "loss_analysis": _loss_analysis(supabase),
        "recent_losses": _recent_losses(supabase),
        "payroll_analysis": _payroll_analysis(supabase),
        "payroll_history": _payroll_history(),
        "employee_roster": _employee_roster(supabase),
        "sales_trend_30d": {"daily_revenue": [{"date": p["date"], "revenue": p["revenue"]} for p in sales_trend_30d["points"]]},
        "revenue_totals": _revenue_totals(supabase),
        "inventory_analysis": _inventory_analysis(supabase),
        "recent_inventory_movements": _recent_inventory_movements(supabase),
        "discount_types": _discount_types(supabase),
        "digital_orders_summary": _digital_orders_summary(supabase),
        "utility_cost_by_type_30d": _utility_cost_by_type_30d(supabase),
        "pnl_summary": _pnl_summary(user),
        "stock_items_analysis": _stock_items_analysis(supabase),
        "business_settings": _business_settings_summary(user),
        "menu_catalog": _menu_catalog_analysis(supabase),
        "menu_addons": _menu_addons(supabase),
    }

    client = OpenAI(api_key=api_key, base_url=GROQ_BASE_URL)
    try:
        completion = client.chat.completions.create(
            model=GROQ_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"DATA:\n{json.dumps(context, default=str)}\n\nQUESTION: {body.question}",
                },
            ],
        )
        raw = completion.choices[0].message.content
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Oishii AI is unavailable right now: {exc}")

    try:
        parsed = json.loads(raw)
        result = OishiAiQueryResponse(answer=parsed.get("answer", raw), chart=parsed.get("chart"))
    except Exception:
        result = OishiAiQueryResponse(answer=raw, chart=None)

    try:
        supabase.table("ai_query_log").insert(
            {"user_id": user.id, "question": body.question, "answer": result.answer}
        ).execute()
    except Exception:
        # Audit logging is best-effort -- don't fail the user-facing answer
        # if ai_query_log hasn't been created/migrated yet.
        pass

    return result
