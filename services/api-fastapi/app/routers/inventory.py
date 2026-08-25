from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.ph_time import today_ph
from app.schemas import (
    ExpiringIngredient,
    IngredientDailySummary,
    IngredientFieldOverrideRequest,
    IngredientOut,
    IngredientRecipeUsage,
    IngredientUpdate,
    InventoryCountRequest,
    InventoryCountResponse,
    LowStockIngredient,
    LowStockSummaryResponse,
)
from app.routers.stock_items import _build_daily_summaries, _upsert_override_entry, get_low_stock_stock_items

router = APIRouter(tags=["inventory"])


def get_low_stock_ingredients(supabase) -> list[LowStockIngredient]:
    """Ingredients at or below their reorder threshold. Extracted so both
    the executive-only Command Center rollup (dashboard_summary.py) and the
    all-roles low-stock-summary endpoint below share one query/filter
    instead of two copies drifting apart."""
    ingredients_result = (
        supabase.table("ingredients").select("id, name, current_stock, reorder_threshold, base_unit").execute()
    )
    return [
        LowStockIngredient(
            id=i["id"],
            name=i["name"],
            current_stock=float(i["current_stock"]),
            reorder_threshold=float(i["reorder_threshold"]),
            base_unit=i["base_unit"],
        )
        for i in ingredients_result.data
        if float(i["current_stock"]) <= float(i["reorder_threshold"])
    ]


@router.get("/inventory", response_model=list[IngredientOut])
def list_inventory(user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = (
        supabase.table("ingredients")
        .select(
            "id, name, category, base_unit, suggested_reorder_unit, cost_volatility, "
            "cost_volatility_tier, shelf_life_note, used_in_note, current_stock, "
            "reorder_threshold, needs_review, unit_cost"
        )
        .order("name")
        .execute()
    )
    return result.data


@router.get("/inventory/low-stock-summary", response_model=LowStockSummaryResponse)
def get_low_stock_summary(user: CurrentUser = Depends(get_current_user)):
    """Proactive low-stock surfacing for the Sidebar badge / Home card --
    no role gate, same posture as Inventory Count/Stock Count themselves
    (every role can see stock levels, only editing catalog fields is
    gated). Reuses the same reorder_threshold comparisons Command Center
    already computes, plus stock_items' own reorder_threshold (previously
    defined but never read anywhere)."""
    supabase = get_supabase()
    ingredients = get_low_stock_ingredients(supabase)
    stock_items = get_low_stock_stock_items(supabase)
    return LowStockSummaryResponse(
        ingredient_count=len(ingredients),
        stock_item_count=len(stock_items),
        ingredients=ingredients[:10],
        stock_items=stock_items[:10],
    )


@router.get("/inventory/expiring-soon", response_model=list[ExpiringIngredient])
def list_expiring_soon(days: int = Query(7, ge=1, le=90), user: CurrentUser = Depends(get_current_user)):
    """Advisory, not exact FIFO tracking: for each ingredient, look at its
    single most recent delivery/trans_in movement that has an expiry_date,
    and flag it if that date falls within the next `days` days. This
    schema has no per-batch remaining-quantity tracking, only a running
    current_stock total, so this can't know whether that specific batch
    has already been fully consumed -- it's a heads-up, not a guarantee.
    """
    supabase = get_supabase()
    horizon = date.today() + timedelta(days=days)

    movements_result = (
        supabase.table("inventory_movements")
        .select("ingredient_id, expiry_date, created_at")
        .in_("type", ["delivery", "trans_in"])
        .not_.is_("expiry_date", "null")
        .order("created_at", desc=True)
        .execute()
    )

    latest_expiry_by_ingredient: dict[str, str] = {}
    for m in movements_result.data:
        # First row seen per ingredient is the most recent (already
        # ordered desc), so only take it the first time.
        latest_expiry_by_ingredient.setdefault(m["ingredient_id"], m["expiry_date"])

    upcoming = {
        ing_id: expiry
        for ing_id, expiry in latest_expiry_by_ingredient.items()
        if date.fromisoformat(expiry) <= horizon
    }
    if not upcoming:
        return []

    ingredients_result = (
        supabase.table("ingredients").select("id, name, base_unit").in_("id", list(upcoming.keys())).execute()
    )
    today = date.today()
    rows = [
        ExpiringIngredient(
            ingredient_id=i["id"],
            ingredient_name=i["name"],
            base_unit=i["base_unit"],
            expiry_date=upcoming[i["id"]],
            days_until_expiry=(date.fromisoformat(upcoming[i["id"]]) - today).days,
        )
        for i in ingredients_result.data
    ]
    rows.sort(key=lambda r: r.days_until_expiry)
    return rows


# ---------------------------------------------------------------------------
# Computed daily summary (New Stocks / Beginning / Usage / Ending) -- 0030.
# Extends the same automation Station Items got in 0028 to plain recipe
# ingredients, whose stock has always been sale-driven (recipe_items via
# _adjust_ingredients_for_size in transactions.py) but never had this
# computed view or a flag-to-correct path -- staff instead saw a blank
# "Counted" sheet, as if nothing was tracked yet.
#
# Registered before /inventory/{ingredient_id} below: FastAPI/Starlette
# matches routes in declaration order, so a static "/inventory/count-entries"
# path must be declared ahead of the "/inventory/{ingredient_id}" pattern or
# every request to it gets swallowed as ingredient_id="count-entries" instead.
# ---------------------------------------------------------------------------


def _ingredient_summary_items(ingredients: list[dict]) -> list[dict]:
    """Shapes plain ingredient rows into the generic {id, ingredient_id,
    current_stock, ingredients} item form _build_daily_summaries already
    understands (it was written for stock_items rows, where a linked item's
    real stock lives on the joined `ingredients` sub-object) -- a plain
    ingredient is trivially its own "linked item" here."""
    return [
        {
            "id": ing["id"],
            "ingredient_id": ing["id"],
            "current_stock": ing["current_stock"],
            "ingredients": {"current_stock": ing["current_stock"]},
        }
        for ing in ingredients
    ]


def _to_ingredient_summary(d: dict) -> IngredientDailySummary:
    return IngredientDailySummary(ingredient_id=d["id"], **{k: v for k, v in d.items() if k != "id"})


@router.get("/inventory/count-entries", response_model=list[IngredientDailySummary])
def list_ingredient_count_entries(
    count_date: date | None = Query(None, alias="date"),
    user: CurrentUser = Depends(get_current_user),
):
    """Hydrates the Ingredient Stock list for a given day (defaults today)
    with the computed New Stocks/Beginning/Usage/Ending -- see module
    docstring above. Not station-scoped: ingredients aren't station-bound
    the way Station Items are."""
    if count_date is None:
        count_date = today_ph()
    supabase = get_supabase()
    ingredients = supabase.table("ingredients").select("id, current_stock").order("name").execute().data
    items = _ingredient_summary_items(ingredients)
    summaries = _build_daily_summaries(supabase, items, count_date, entry_column="ingredient_id")
    return [_to_ingredient_summary(s) for s in summaries]


@router.get("/inventory/{ingredient_id}", response_model=IngredientOut)
def get_ingredient(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("ingredients").select("*").eq("id", ingredient_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return result.data


@router.patch("/inventory/{ingredient_id}", response_model=IngredientOut)
def update_ingredient(
    ingredient_id: str,
    body: IngredientUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    """Direct edit of any ingredient catalog field -- name, category,
    base_unit, suggested_reorder_unit, reorder_threshold, cost_volatility(_
    tier), shelf_life_note, used_in_note, unit_cost. Executive-only, since
    unit_cost feeds the P&L dashboard's COGS calculation and the rest
    (especially base_unit) are the kind of "critical measurement" that
    should require deliberate admin action, not casual editing.

    JUDGMENT CALL: changing base_unit does NOT rescale current_stock,
    reorder_threshold, or any recipe_items.qty_per_serving that references
    this ingredient -- this schema has no unit-conversion table anywhere,
    units are just labels the caller is trusted to keep consistent. The
    frontend is expected to warn the admin (via GET .../recipe-usage below)
    before letting them change it, but this endpoint itself has no way to
    know whether "g" -> "pack" is intentional and correct.
    """
    require_role(user, "executive")
    supabase = get_supabase()
    existing = supabase.table("ingredients").select("id").eq("id", ingredient_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = supabase.table("ingredients").update(update_data).eq("id", ingredient_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return result.data[0]


@router.get("/inventory/{ingredient_id}/recipe-usage", response_model=list[IngredientRecipeUsage])
def get_ingredient_recipe_usage(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    """Reverse lookup: every recipe (product + size) that uses this
    ingredient, and how much. No such lookup existed before -- recipes are
    normally fetched forward, by product_size_id (recipes.py). This exists
    so the ingredient-edit UI can warn "this unit change affects N recipes"
    with real specifics instead of a vague warning."""
    supabase = get_supabase()
    result = (
        supabase.table("recipe_items")
        .select("qty_per_serving, unit, product_sizes(size_label, products(name))")
        .eq("ingredient_id", ingredient_id)
        .execute()
    )
    rows = []
    for r in result.data:
        size = r["product_sizes"]
        rows.append(
            IngredientRecipeUsage(
                product_name=size["products"]["name"],
                size_label=size["size_label"],
                qty_per_serving=r["qty_per_serving"],
                unit=r["unit"],
            )
        )
    rows.sort(key=lambda r: (r.product_name, r.size_label))
    return rows


def apply_ingredient_count(
    supabase, ingredient_id: str, counted_stock: float, employee_id: str, note: str | None = None
) -> InventoryCountResponse:
    """Records a physical stock count. Unlike a manual movement, a count
    sets current_stock directly to what was actually counted rather than
    applying a delta -- and, when the counted value differs from what the
    system expected, logs a count_adjustment movement (previous/counted/
    signed variance) so the discrepancy has a real audit trail instead of
    silently vanishing into an overwrite. A zero-variance count logs nothing.

    Factored out of the /inventory/{id}/count route so the physical
    stock-count tool (stock_items.py) can drive the exact same
    current_stock-mutation + audit-trail path for a linked stock item's
    "Ending" figure, instead of a second competing way to set current_stock.
    """
    existing = (
        supabase.table("ingredients").select("current_stock").eq("id", ingredient_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    previous_stock = float(existing.data["current_stock"])
    variance = round(counted_stock - previous_stock, 4)

    result = (
        supabase.table("ingredients").update({"current_stock": counted_stock}).eq("id", ingredient_id).execute()
    )
    updated_ingredient = result.data[0]

    movement = None
    if variance != 0:
        reason = f"Stock count: {previous_stock} -> {counted_stock} (variance {variance:+})"
        if note:
            reason = f"{note} -- {reason}"
        movement_result = (
            supabase.table("inventory_movements")
            .insert(
                {
                    "ingredient_id": ingredient_id,
                    "type": "count_adjustment",
                    "quantity": abs(variance),
                    "reason": reason,
                    "employee_id": employee_id,
                }
            )
            .execute()
        )
        movement = movement_result.data[0]

    return InventoryCountResponse(ingredient=updated_ingredient, movement=movement, variance=variance)


@router.post("/inventory/{ingredient_id}/count", response_model=InventoryCountResponse)
def count_inventory(
    ingredient_id: str,
    body: InventoryCountRequest,
    user: CurrentUser = Depends(get_current_user),
):
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a count under another employee's id")
    supabase = get_supabase()
    return apply_ingredient_count(supabase, ingredient_id, body.counted_stock, body.employee_id)


@router.post("/inventory/{ingredient_id}/field-override", response_model=IngredientDailySummary)
def override_ingredient_field(
    ingredient_id: str,
    body: IngredientFieldOverrideRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Flag-to-edit: staff review the auto-computed New Stocks/Beginning/
    Usage/Ending and only reach this endpoint when one looks wrong. Every
    call requires a reason and writes an audited correction -- never a
    silent overwrite of the computed value. Mirrors stock_items.py's
    override_stock_item_field for a linked stock item, minus the
    linked/unlinked branch (a plain ingredient has no such split)."""
    if body.employee_id != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a correction under another employee's id")

    supabase = get_supabase()
    existing = (
        supabase.table("ingredients").select("id, current_stock").eq("id", ingredient_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    ingredient = existing.data
    count_date = body.count_date or today_ph()

    if body.field == "beginning":
        # Beginning is informational carry-forward context -- it has never
        # driven current_stock, and shouldn't start now. Just record it.
        pass
    elif body.field == "ending":
        apply_ingredient_count(supabase, ingredient_id, body.corrected_value, body.employee_id, note=body.reason)
    else:
        # new_stocks / usage: figure out how current_stock itself needs to
        # move so the corrected value is what future summaries compute --
        # same delta math as override_stock_item_field's else-branch.
        item = _ingredient_summary_items([ingredient])[0]
        auto = _build_daily_summaries(supabase, [item], count_date, entry_column="ingredient_id")[0]
        auto_value = auto["new_stocks"] if body.field == "new_stocks" else auto["usage"]
        field_delta = body.corrected_value - auto_value
        stock_delta = field_delta if body.field == "new_stocks" else -field_delta

        if stock_delta != 0:
            current = (
                supabase.table("ingredients").select("current_stock").eq("id", ingredient_id).maybe_single().execute()
            ).data
            new_stock = float(current["current_stock"]) + stock_delta
            supabase.table("ingredients").update({"current_stock": new_stock}).eq("id", ingredient_id).execute()
            supabase.table("inventory_movements").insert(
                {
                    "ingredient_id": ingredient_id,
                    "type": "count_adjustment",
                    "quantity": abs(stock_delta),
                    "reason": f"{body.reason} -- {body.field} corrected to {body.corrected_value}",
                    "employee_id": body.employee_id,
                }
            ).execute()

    _upsert_override_entry(
        supabase, "ingredient_id", ingredient_id, count_date, body.field, body.corrected_value, body.reason, body.employee_id
    )

    refreshed = supabase.table("ingredients").select("id, current_stock").eq("id", ingredient_id).maybe_single().execute()
    item = _ingredient_summary_items([refreshed.data])[0]
    summary = _build_daily_summaries(supabase, [item], count_date, entry_column="ingredient_id")[0]
    return _to_ingredient_summary(summary)
