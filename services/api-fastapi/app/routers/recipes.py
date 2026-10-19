from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.routers.sales_insights import _page_rows
from app.schemas import RecipeCoverageResponse, RecipeItemOut

router = APIRouter(tags=["recipes"])


def _get_recipe_data(supabase, product_size_id: str) -> list[dict]:
    """Shared query body behind both the authenticated `/product-sizes/{id}/
    recipe` route and the public digital-menu variant -- ingredient names
    aren't sensitive (the same info is already shown to POS staff), so
    exposing them publicly is safe; it's exactly what a customer-facing
    menu's "what's inside" / hold-an-ingredient UI needs.

    JUDGMENT CALL: this build's recipe_items hangs off product_sizes, not
    products (see task spec: size-tier recipe deduction), so the route is
    keyed on product_size_id rather than SMFC's product_id. A bundle's size
    (Platter/Sushi Boat) legitimately returns an empty list -- its BOM is
    only known at kitchen bundle-fulfillment time, see transactions.py.
    """
    size_result = (
        supabase.table("product_sizes").select("id").eq("id", product_size_id).maybe_single().execute()
    )
    if not size_result or not size_result.data:
        raise HTTPException(status_code=404, detail="Product size not found")

    result = (
        supabase.table("recipe_items")
        .select("*, ingredients(name)")
        .eq("product_size_id", product_size_id)
        .execute()
    )
    items = []
    for row in result.data:
        ingredient = row.pop("ingredients", None) or {}
        row["ingredient_name"] = ingredient.get("name", "Unknown")
        items.append(row)
    return items


@router.get("/product-sizes/{product_size_id}/recipe", response_model=list[RecipeItemOut])
def get_recipe(product_size_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    return _get_recipe_data(supabase, product_size_id)


@router.get("/recipes/coverage", response_model=RecipeCoverageResponse)
def recipe_coverage(user: CurrentUser = Depends(get_current_user)):
    """Stock -> Recipes & Costs: which active menu sizes still have no
    recipe, which ingredients still have no unit cost, and each recipe's
    cost per serving. Opened on demand only (no polling)."""
    require_role_or_grant(user, "stock", "manager", "executive")
    supabase = get_supabase()
    products = supabase.table("products").select("id, name, category, is_bundle").eq("active", True).execute().data
    product_ids = [p["id"] for p in products]
    sizes = (
        _page_rows(supabase.table("product_sizes").select("id, product_id, size_label, price, sort_order")
                   .in_("product_id", product_ids).order("sort_order").order("id"))
        if product_ids else []
    )
    recipe_rows = _page_rows(supabase.table("recipe_items").select("product_size_id, ingredient_id, qty_per_serving").order("id"))
    rule_rows = _page_rows(
        supabase.table("stock_consumption_rules").select("product_size_id")
        .eq("active", True).eq("trigger_type", "per_product_unit").order("id")
    )
    ingredients = _page_rows(supabase.table("ingredients").select("id, name, category, base_unit, unit_cost").order("name"))
    ingredient_by_id = {i["id"]: i for i in ingredients}

    product_by_id = {p["id"]: p for p in products}
    size_name = {
        s["id"]: f'{product_by_id[s["product_id"]]["name"]} ({s["size_label"]})' for s in sizes
    }
    lines_by_size: dict[str, list[dict]] = defaultdict(list)
    for row in recipe_rows:
        lines_by_size[row["product_size_id"]].append(row)
    rules_by_size: dict[str, int] = defaultdict(int)
    for row in rule_rows:
        rules_by_size[row["product_size_id"]] += 1

    used_in: dict[str, list[str]] = defaultdict(list)
    sizes_by_product: dict[str, list[dict]] = defaultdict(list)
    for size in sizes:
        lines = lines_by_size.get(size["id"], [])
        cost = 0.0
        missing: list[str] = []
        for line in lines:
            ingredient = ingredient_by_id.get(line["ingredient_id"])
            if not ingredient:
                continue
            used_in[ingredient["id"]].append(size_name[size["id"]])
            if ingredient["unit_cost"] is None:
                missing.append(ingredient["name"])
            else:
                cost += float(line["qty_per_serving"]) * float(ingredient["unit_cost"])
        sizes_by_product[size["product_id"]].append({
            "id": size["id"],
            "size_label": size["size_label"],
            "price": float(size["price"] or 0),
            "recipe_lines": len(lines),
            "consumption_rules": rules_by_size.get(size["id"], 0),
            "cost": round(cost, 2) if lines else None,
            "missing_cost": sorted(set(missing)),
        })

    return {
        "products": [
            {**p, "is_bundle": bool(p.get("is_bundle")), "sizes": sizes_by_product.get(p["id"], [])}
            for p in sorted(products, key=lambda p: (p["category"] or "", p["name"]))
        ],
        "ingredients": [
            {
                "id": i["id"], "name": i["name"], "category": i["category"], "base_unit": i["base_unit"],
                "unit_cost": float(i["unit_cost"]) if i["unit_cost"] is not None else None,
                "used_in": len(used_in.get(i["id"], [])),
                "used_in_examples": used_in.get(i["id"], [])[:4],
            }
            for i in ingredients
        ],
    }
