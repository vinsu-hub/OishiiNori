"""Smart suggestions and the prep list (app/suggestions.py does the maths).

Worked out at most once an hour (or after an accept / dismiss), on first
open: a handful of batched queries plus one paged usage rollup done in the
database. Vercel bills CPU, and this is not on any hot path.
"""
from datetime import datetime, timedelta, timezone

from cachetools import TTLCache
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import suggestions as smart
from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.edit_log import log_item_edit
from app.ph_time import PH_UTC_OFFSET, today_ph
from app.prep_chain import batches_supported, clear_cache as clear_chain_cache
from app.routers.sales_insights import _page_rows

router = APIRouter(tags=["suggestions"])

WINDOW_DAYS = 35  # 4 same weekdays back, plus slack
_cache: TTLCache = TTLCache(maxsize=1, ttl=3600)


class Suggestion(BaseModel):
    key: str
    kind: str  # yield | usage | mode
    ingredient_id: str
    title: str
    detail: str
    action: dict | None = None


class PrepItem(BaseModel):
    ingredient_id: str
    name: str
    unit: str
    expected_use: float
    in_stock: float
    batches: int
    makes: float


class PullItem(BaseModel):
    ingredient_id: str
    name: str
    unit: str
    qty: float
    in_stock: float


class PrepList(BaseModel):
    for_date: str
    items: list[PrepItem]
    pull: list[PullItem]


class SuggestionsOut(BaseModel):
    suggestions: list[Suggestion]
    prep_list: PrepList | None = None


class KeyIn(BaseModel):
    key: str


def clear_suggestions_cache() -> None:
    _cache.clear()


def _prep_target() -> "datetime.date":
    """From 2 pm the list is for tomorrow (EOD prep); before, for today."""
    now_ph = datetime.now(timezone.utc) + PH_UTC_OFFSET
    return today_ph() + timedelta(days=1 if now_ph.hour >= 14 else 0)


def _compute(supabase) -> SuggestionsOut:
    if not batches_supported(supabase):
        return SuggestionsOut(suggestions=[])
    ings = supabase.table("ingredients").select(
        "id, name, base_unit, current_stock, prep_yield, deduct_mode, active").execute().data or []
    ings = [i for i in ings if i.get("active", True)]
    by_id = {i["id"]: i for i in ings}
    components = supabase.table("prep_recipe_items").select("base_ingredient_id, ingredient_id, qty").execute().data or []
    made_ids = {c["base_ingredient_id"] for c in components}
    bases = [i for i in ings if i.get("prep_yield") and i["id"] in made_ids]
    plain = [i for i in ings if i["id"] not in made_ids]

    since = today_ph() - timedelta(days=WINDOW_DAYS)
    since_utc = (datetime.combine(since, datetime.min.time()) - PH_UTC_OFFSET).replace(tzinfo=timezone.utc).isoformat()
    counts = _page_rows(supabase.table("ingredient_counts").select("ingredient_id, variance, created_at")
                        .gte("created_at", since_utc).order("created_at").order("id"))
    batches = _page_rows(supabase.table("prep_batches").select("base_ingredient_id, batches, created_at")
                         .gte("created_at", since_utc).order("created_at").order("id"))
    usage = _page_rows(supabase.rpc("ingredient_daily_usage", {"p_since": since.isoformat()})
                       .order("ingredient_id").order("day"))

    dismissed = {r["key"] for r in (supabase.table("suggestion_dismissals").select("key")
                                     .gte("dismissed_at", (datetime.now(timezone.utc) - timedelta(days=30)).isoformat())
                                     .execute().data or [])}
    found = [
        *smart.yield_drift(bases, counts, batches),
        *smart.mode_hints(bases, counts, batches),
        *smart.usage_drift(plain, counts, usage),
    ]
    return SuggestionsOut(
        suggestions=[Suggestion(**s) for s in found if s["key"] not in dismissed],
        prep_list=PrepList(**smart.prep_list(bases, components, by_id, usage, _prep_target())),
    )


def _get(supabase) -> SuggestionsOut:
    if "all" not in _cache:
        _cache["all"] = _compute(supabase)
    return _cache["all"]


@router.get("/suggestions", response_model=SuggestionsOut)
def list_suggestions(user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive", "manager", "stocker")
    out = _get(get_supabase())
    if user.role == "stocker":  # the prep list is for everyone; changes are for the bosses
        return SuggestionsOut(suggestions=[], prep_list=out.prep_list)
    return out


@router.post("/suggestions/dismiss", status_code=204)
def dismiss_suggestion(body: KeyIn, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive", "manager")
    supabase = get_supabase()
    supabase.table("suggestion_dismissals").upsert(
        {"key": body.key, "dismissed_by": user.id, "dismissed_at": datetime.now(timezone.utc).isoformat()}
    ).execute()
    clear_suggestions_cache()


@router.post("/suggestions/accept", response_model=SuggestionsOut)
def accept_suggestion(body: KeyIn, user: CurrentUser = Depends(get_current_user)):
    """Apply a suggestion's change (a new batch yield, or auto mode)."""
    require_role(user, "executive")
    supabase = get_supabase()
    current = _compute(supabase)  # fresh, never act on a stale hour-old number
    s = next((x for x in current.suggestions if x.key == body.key), None)
    if not s:
        raise HTTPException(status_code=404, detail="That suggestion no longer applies")
    if not s.action:
        raise HTTPException(status_code=400, detail="This one is for a person to check, there's nothing to apply")

    from app.routers.prep_bases import _apply_cost, _load, recompute_bases_using

    (base,) = _load(supabase, [s.ingredient_id])
    if "prep_yield" in s.action:
        new_yield = float(s.action["prep_yield"])
        supabase.table("ingredients").update({"prep_yield": new_yield}).eq("id", s.ingredient_id).execute()
        log_item_edit(supabase, "batch yield", base.prep_yield, new_yield, user.id, ingredient_id=s.ingredient_id)
        (fresh,) = _load(supabase, [s.ingredient_id])
        after = _apply_cost(supabase, fresh, user.id, "batch yield from counts")
        if after.unit_cost != fresh.unit_cost:
            recompute_bases_using(supabase, s.ingredient_id, user.id)
    if "deduct_mode" in s.action:
        supabase.table("ingredients").update({"deduct_mode": s.action["deduct_mode"]}).eq("id", s.ingredient_id).execute()
        log_item_edit(supabase, "deduct mode", base.deduct_mode, s.action["deduct_mode"], user.id, ingredient_id=s.ingredient_id)
    clear_chain_cache()
    clear_suggestions_cache()
    return _get(supabase)
