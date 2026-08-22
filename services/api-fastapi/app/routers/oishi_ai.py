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
  just the 10 most recent rows).
- loss_analysis.by_reason: total loss cost grouped by cause (spoilage,
  breakage, comp, prep_error, shrinkage) -- use for "why are we losing
  money", "what's our biggest loss category", or "how much have we lost to
  spoilage" style questions (look up the "spoilage" key specifically for
  that last one).
- recent_losses: the 10 most recent individual loss log entries, for
  "what was just logged" / recency-style questions -- not a complete
  all-time picture.
- payroll_analysis: aggregate payroll for the CURRENT semimonthly pay
  period only (see period_start/period_end in this field) --
  total_payroll_cost, total_hours, employee_count. Use
  top_overtime_holiday_driver for "who's costing the most in OT/holiday
  pay this period" questions.
- payroll_history: up to the last 8 generated payroll runs (period_start,
  period_end, total_pay, total_hours, employee_count, created_at), most
  recent first -- use for "how much did we spend on payroll last
  month/period" or any historical/period-over-period payroll question that
  payroll_analysis (current period only) can't answer. If the period asked
  about isn't in this list, say so rather than guessing.
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
- inventory_analysis.all_ingredients: every ingredient's category and
  current stock (as a "quantity unit" string, e.g. "500 g") -- use this
  for "what's my current stock of X" for ANY ingredient, not just ones
  running low. It does not carry reorder_threshold or needs_review --
  those are only on low_stock_items (for the ingredients that are
  actually low) and needs_review_count (aggregate only). There is no
  cost/valuation figure for inventory in this data -- don't invent one.
- inventory_analysis.low_stock_items / low_stock_count: ingredients at or
  below their reorder threshold, worst shortage first, capped at 15 rows
  (low_stock_count is the true total even if the list is capped) -- use
  for "what needs restocking" questions specifically.
- inventory_analysis.by_category / total_ingredient_count /
  needs_review_count: use for "how many ingredients do we stock", "what
  needs review", or category-breakdown questions.
- recent_inventory_movements: last 8 stock movements (delivery, transfer,
  count adjustment, etc.) with ingredient, quantity, reason, employee, and
  when -- use for "what was just received/adjusted" questions.
- discount_types: currently active discounts (name, percentage,
  vat_exempt) -- use for "what discounts do we offer" questions.
- digital_orders_summary: count of QR/digital-menu orders by status
  (pending/approved/rejected), all-time -- use for "how many online
  orders are pending/have we gotten" questions.
- utility_cost_by_type_30d: utility cost (electricity/water/gas) summed
  over the trailing 30 days -- use for "what's our biggest utility cost"
  or utility-spend questions beyond just today (todays_summary has
  today's utility cost only).
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


def _payroll_history(limit: int = 8) -> list[dict]:
    result = (
        hr_table("payroll_records")
        .select("period_start, period_end, total_hours, total_pay, employee_count, created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data


def _recent_inventory_movements(supabase, limit: int = 8) -> list[dict]:
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
        {
            "ingredient": name_by_ingredient.get(r["ingredient_id"], "Unknown"),
            "type": r["type"],
            "quantity": r["quantity"],
            "reason": r.get("reason"),
            "employee": name_by_employee.get(r["employee_id"]) if r.get("employee_id") else None,
            "logged_at": r["created_at"],
        }
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


def _recent_losses(supabase, limit: int = 10) -> list[dict]:
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
        {
            "ingredient": name_by_id.get(r["ingredient_id"], "Unknown"),
            "reason": r["reason"],
            "quantity": r["quantity"],
            "cost_impact": r["cost_impact"],
            "logged_at": r["created_at"],
        }
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
        # Deliberately terse (3 fields, not the 6 low_stock_items carries) --
        # this list alone was over half the total context payload at full
        # width (73 rows), which pushed requests over Groq's free-tier
        # 8000 TPM cap. reorder_threshold/needs_review stay available via
        # low_stock_items / needs_review_count for the rows that need them.
        "all_ingredients": [
            {"ingredient": r["name"], "category": r.get("category"), "stock": f"{r['current_stock']} {r['base_unit']}"}
            for r in rows
        ],
    }


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
