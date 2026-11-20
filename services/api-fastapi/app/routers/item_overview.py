"""Item page: everything about one ingredient in one call (migration 0089).

Sir Joe used to look in four places (EOD Count, Unit costs, Prep bases,
Ingredients). This gathers it: the item and its sizes, what it's made from
and what it goes into (the batch chain, both ways, with stock at each
step), the menu recipes that use it, its last 14 days of use, recent stock
movements and batches, and who changed what.

A handful of batched queries, no per-row calls: Vercel bills CPU.
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.ph_time import PH_UTC_OFFSET, today_ph
from app.prep_chain import MAX_DEPTH, batches_supported

router = APIRouter(tags=["item-overview"])

USAGE_DAYS = 14
_OUT = {"sale_consumption", "trans_out", "transfer_out"}


class ChainNode(BaseModel):
    ingredient_id: str
    name: str
    base_unit: str
    current_stock: float
    # Per batch of the parent (made_from) or per batch of this node (goes_into).
    qty: float
    prep_yield: float | None = None
    deduct_mode: str = "batch"
    children: list["ChainNode"] = []


class RecipeUse(BaseModel):
    product_name: str
    size_label: str
    qty_per_serving: float
    unit: str | None = None


class DayUse(BaseModel):
    date: str
    used: float


class MovementOut(BaseModel):
    type: str
    quantity: float
    signed_qty: float | None = None
    reason: str | None = None
    created_at: str
    by: str | None = None


class BatchOut(BaseModel):
    batches: float
    yield_qty: float
    source: str
    note: str | None = None
    created_at: str
    by: str | None = None


class EditOut(BaseModel):
    field: str
    before: object | None = None
    after: object | None = None
    created_at: str
    by: str | None = None


class ItemOverview(BaseModel):
    id: str
    name: str
    base_unit: str
    category: str | None = None
    station: str | None = None
    sheet_section: str | None = None
    current_stock: float
    reorder_threshold: float = 0
    unit_cost: float | None = None
    prep_yield: float | None = None
    deduct_mode: str = "batch"
    sizes: list[dict]
    made_from: list[ChainNode]
    goes_into: list[ChainNode]
    recipes: list[RecipeUse]
    usage: list[DayUse]
    avg_daily_use: float | None = None
    days_left: float | None = None
    batches_possible: float | None = None
    movements: list[MovementOut]
    batches: list[BatchOut]
    edits: list[EditOut]


def _who(row: dict) -> str | None:
    p = row.get("profiles")
    return p.get("full_name") if isinstance(p, dict) else None


@router.get("/inventory/{ingredient_id}/overview", response_model=ItemOverview)
def item_overview(ingredient_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive", "manager", "stocker")
    supabase = get_supabase()
    v89 = batches_supported(supabase)
    cols = "id, name, base_unit, category, station, sheet_section, current_stock, reorder_threshold, unit_cost, prep_yield"
    if v89:
        cols += ", deduct_mode"

    # The batch chain is a small table: read it all once and walk it here.
    links = supabase.table("prep_recipe_items").select("base_ingredient_id, ingredient_id, qty").execute().data or []
    ids = {ingredient_id} | {r["base_ingredient_id"] for r in links} | {r["ingredient_id"] for r in links}
    ings = {r["id"]: r for r in (supabase.table("ingredients").select(cols).in_("id", sorted(ids)).execute().data or [])}
    item = ings.get(ingredient_id)
    if not item:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    takes: dict[str, list[dict]] = defaultdict(list)  # base -> its components
    used_by: dict[str, list[dict]] = defaultdict(list)  # component -> bases
    for r in links:
        takes[r["base_ingredient_id"]].append(r)
        used_by[r["ingredient_id"]].append(r)

    def node(iid: str, qty: float, children: list[ChainNode]) -> ChainNode:
        i = ings.get(iid, {})
        return ChainNode(
            ingredient_id=iid, name=i.get("name", "?"), base_unit=i.get("base_unit", ""),
            current_stock=float(i.get("current_stock") or 0), qty=qty,
            prep_yield=float(i["prep_yield"]) if i.get("prep_yield") else None,
            deduct_mode=i.get("deduct_mode") or "batch", children=children,
        )

    def down(iid: str, depth: int, seen: frozenset) -> list[ChainNode]:
        if depth >= MAX_DEPTH:
            return []
        return [node(r["ingredient_id"], float(r["qty"]), down(r["ingredient_id"], depth + 1, seen | {iid}))
                for r in takes.get(iid, []) if r["ingredient_id"] not in seen]

    def up(iid: str, depth: int, seen: frozenset) -> list[ChainNode]:
        if depth >= MAX_DEPTH:
            return []
        return [node(r["base_ingredient_id"], float(r["qty"]), up(r["base_ingredient_id"], depth + 1, seen | {iid}))
                for r in used_by.get(iid, []) if r["base_ingredient_id"] not in seen]

    made_from = down(ingredient_id, 0, frozenset())
    goes_into = up(ingredient_id, 0, frozenset())

    sizes = supabase.table("item_units").select("id, name, base_qty").eq("ingredient_id", ingredient_id).execute().data or []

    recipes = [
        RecipeUse(product_name=(r.get("product_sizes") or {}).get("products", {}).get("name", "?"),
                  size_label=(r.get("product_sizes") or {}).get("size_label", ""),
                  qty_per_serving=float(r["qty_per_serving"]), unit=r.get("unit"))
        for r in (supabase.table("recipe_items").select("qty_per_serving, unit, product_sizes(size_label, products(name))")
                  .eq("ingredient_id", ingredient_id).execute().data or [])
    ]
    recipes.sort(key=lambda r: (r.product_name, r.size_label))

    # Last 14 PH days of use, from movements (sales minus voids, plus hand-outs).
    today = today_ph()
    start = datetime.combine(today - timedelta(days=USAGE_DAYS - 1), datetime.min.time()) - PH_UTC_OFFSET
    mcols = "type, quantity, reason, created_at, profiles(full_name)" + (", signed_qty" if v89 else "")
    moves = (supabase.table("inventory_movements").select(mcols).eq("ingredient_id", ingredient_id)
             .gte("created_at", start.replace(tzinfo=timezone.utc).isoformat())
             .order("created_at", desc=True).limit(2000).execute().data) or []
    per_day: dict[str, float] = defaultdict(float)
    for m in moves:
        day = (datetime.fromisoformat(m["created_at"].replace("Z", "+00:00")) + PH_UTC_OFFSET).date().isoformat()
        q = float(m["quantity"])
        if m["type"] in _OUT:
            per_day[day] += q
        elif m["type"] == "sale_consumption_reversal":
            per_day[day] -= q
    usage = [DayUse(date=(today - timedelta(days=d)).isoformat(), used=round(per_day[(today - timedelta(days=d)).isoformat()], 4))
             for d in range(USAGE_DAYS - 1, -1, -1)]
    # Average over the days before today (today isn't over yet).
    past = [u.used for u in usage[:-1]]
    avg = round(sum(past) / len(past), 4) if past and sum(past) > 0 else None
    stock = float(item.get("current_stock") or 0)
    days_left = round(stock / avg, 1) if avg else None

    batches_possible = None
    if item.get("prep_yield") and takes.get(ingredient_id):
        limits = [float(ings.get(r["ingredient_id"], {}).get("current_stock") or 0) / float(r["qty"])
                  for r in takes[ingredient_id] if float(r["qty"]) > 0]
        batches_possible = round(max(0.0, min(limits)), 1) if limits else None

    batches, edits = [], []
    if v89:
        batches = [
            BatchOut(batches=float(b["batches"]), yield_qty=float(b["yield_qty"]), source=b["source"], note=b.get("note"),
                     created_at=b["created_at"], by=_who(b))
            for b in (supabase.table("prep_batches").select("batches, yield_qty, source, note, created_at, profiles(full_name)")
                      .eq("base_ingredient_id", ingredient_id).order("created_at", desc=True).limit(10).execute().data or [])
        ]
        edits = [
            EditOut(field=e["field"], before=e.get("before"), after=e.get("after"), created_at=e["created_at"], by=_who(e))
            for e in (supabase.table("item_edit_log").select("field, before, after, created_at, profiles(full_name)")
                      .eq("ingredient_id", ingredient_id).order("created_at", desc=True).limit(20).execute().data or [])
        ]

    return ItemOverview(
        id=item["id"], name=item["name"], base_unit=item["base_unit"], category=item.get("category"),
        station=item.get("station"), sheet_section=item.get("sheet_section"), current_stock=stock,
        reorder_threshold=float(item.get("reorder_threshold") or 0),
        unit_cost=(float(item["unit_cost"]) if item.get("unit_cost") is not None and user.role == "executive" else None),
        prep_yield=float(item["prep_yield"]) if item.get("prep_yield") else None,
        deduct_mode=item.get("deduct_mode") or "batch",
        sizes=[{"id": s["id"], "name": s["name"], "base_qty": float(s["base_qty"])} for s in sizes],
        made_from=made_from, goes_into=goes_into, recipes=recipes, usage=usage,
        avg_daily_use=avg, days_left=days_left, batches_possible=batches_possible,
        movements=[
            MovementOut(type=m["type"], quantity=float(m["quantity"]),
                        signed_qty=float(m["signed_qty"]) if m.get("signed_qty") is not None else None,
                        reason=m.get("reason"), created_at=m["created_at"], by=_who(m))
            for m in moves[:20]
        ],
        batches=batches, edits=edits,
    )
