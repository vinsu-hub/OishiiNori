import json
import os
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from openai import OpenAI

from app.attendance_utils import hr_table
from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.routers.analytics import get_sales_trend, get_top_products
from app.routers.dashboard_summary import get_dashboard_summary
from app.routers.hr import _compute_payroll_summary
from app.schemas import OishiAiQueryRequest, OishiAiQueryResponse

router = APIRouter(tags=["oishi-ai"])

XAI_MODEL = "grok-4"
XAI_BASE_URL = "https://api.x.ai/v1"

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
- top_products_today: units sold today per product, ranked by revenue
  descending. Use this for "what's my best seller" / "what's trending"
  style questions -- today's sales only, not all-time.
- loss_analysis.accumulated_loss_total: total cost of EVERY loss ever
  logged (all-time, not just today) -- use this for "accumulated loss" /
  "total loss" / "how much have we lost overall" questions.
- loss_analysis.top_loss_item: the single ingredient responsible for the
  most cumulative loss cost across all logged losses -- use this to answer
  "what item generates the most loss", "biggest source of waste", etc. It
  already IS the answer; don't recompute it from recent_losses (incomplete,
  just the 10 most recent rows).
- loss_analysis.by_reason: total loss cost grouped by cause (spoilage,
  breakage, comp, prep_error, other) -- use for "why are we losing money" /
  "what's our biggest loss category" questions.
- recent_losses: the 10 most recent individual loss log entries, for
  "what was just logged" / recency-style questions -- not a complete
  all-time picture.
- payroll_analysis: aggregate payroll for the CURRENT semimonthly pay
  period only (see period_start/period_end in this field) --
  total_payroll_cost, total_hours, employee_count. Use
  top_overtime_holiday_driver for "who's costing the most in OT/holiday
  pay" questions. This is a summary, not a per-employee breakdown -- don't
  invent individual pay figures beyond the one named driver.
- sales_trend_30d.daily_revenue: revenue per calendar day for the last 30
  days -- use for trend / week-over-week / month-scale comparison
  questions, not todays_summary.
- inventory_analysis.low_stock_items: ingredients at or below their
  reorder threshold, worst shortage first, capped at 15 rows -- use for
  "what needs restocking" questions. low_stock_count is the true total
  even if the list is capped. There is no cost/valuation figure for
  inventory in this data -- don't invent one.
"""


def _top_products(user: CurrentUser) -> list[dict]:
    today = date.today()
    result = get_top_products(date_from=today, date_to=today, limit=5, user=user)
    return [
        {"product": p.product_name, "units_sold_today": p.quantity_sold, "revenue_today": p.revenue}
        for p in result.products
    ]


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
    """Bounded, worst-first low-stock list. No unit_cost column exists on
    ingredients in this schema (see loss_records.py), so unlike the SMFC
    reference there is no total-valuation figure here."""
    ingredients_result = (
        supabase.table("ingredients").select("name, base_unit, current_stock, reorder_threshold").execute()
    )
    rows = ingredients_result.data

    low_stock = [r for r in rows if float(r["current_stock"]) <= float(r["reorder_threshold"])]
    low_stock.sort(key=lambda r: float(r["current_stock"]) - float(r["reorder_threshold"]))

    return {
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
    }


@router.post("/ai/query", response_model=OishiAiQueryResponse)
def query_oishi_ai(body: OishiAiQueryRequest, user: CurrentUser = Depends(get_current_user)):
    # Executive-only: the context this endpoint aggregates (dashboard
    # summary, sales trend, top products) is itself executive-gated
    # elsewhere in this app (Oishii is single-location, unlike the SMFC
    # reference's manager-scoped-to-own-branch model), so there is no
    # narrower scope a manager could safely see here anyway.
    require_role(user, "executive")

    api_key = os.environ.get("XAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Oishii AI isn't configured (missing XAI_API_KEY)")

    supabase = get_supabase()

    # on_date/date_from/date_to must be passed explicitly here: FastAPI's
    # Query(None, ...) default is a FieldInfo marker resolved to None only
    # via request-time dependency injection, not when called as a plain
    # Python function the way this router calls it.
    todays_summary = get_dashboard_summary(on_date=None, user=user).model_dump(mode="json")
    sales_trend_30d = get_sales_trend(date_from=None, date_to=None, user=user).model_dump(mode="json")

    context = {
        "todays_summary": todays_summary,
        "top_products_today": _top_products(user),
        "loss_analysis": _loss_analysis(supabase),
        "recent_losses": _recent_losses(supabase),
        "payroll_analysis": _payroll_analysis(supabase),
        "sales_trend_30d": {"daily_revenue": [{"date": p["date"], "revenue": p["revenue"]} for p in sales_trend_30d["points"]]},
        "inventory_analysis": _inventory_analysis(supabase),
    }

    client = OpenAI(api_key=api_key, base_url=XAI_BASE_URL)
    try:
        completion = client.chat.completions.create(
            model=XAI_MODEL,
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
