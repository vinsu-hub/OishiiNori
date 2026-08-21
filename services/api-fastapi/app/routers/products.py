from collections import defaultdict

from fastapi import APIRouter, Depends, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import ProductOut

router = APIRouter(tags=["products"])


def _compute_size_availability(supabase, product_size_ids: list[str]) -> dict[str, str]:
    """Per-product_size availability, cross-referencing recipe_items against
    current ingredient stock -- "unavailable" if any required ingredient
    can't cover one more serving of that size, "low_stock" if any required
    ingredient is at or under its reorder threshold, else "available".

    JUDGMENT CALL: computed per product_size (not per product), since this
    build's recipes hang off product_sizes -- two sizes of the same product
    can have different availability (e.g. Small in stock, Large not). A
    bundle's size has no recipe_items at all (its consumption is only known
    at kitchen bundle-fulfillment time, not at order time), so it always
    resolves to "available" here by construction.
    """
    if not product_size_ids:
        return {}

    recipe_result = (
        supabase.table("recipe_items")
        .select("product_size_id, ingredient_id, qty_per_serving")
        .in_("product_size_id", product_size_ids)
        .execute()
    )
    recipe_rows = recipe_result.data
    if not recipe_rows:
        return {psid: "available" for psid in product_size_ids}

    ingredient_ids = {r["ingredient_id"] for r in recipe_rows}
    ingredients_result = (
        supabase.table("ingredients")
        .select("id, current_stock, reorder_threshold")
        .in_("id", list(ingredient_ids))
        .execute()
    )
    stock_by_ingredient = {i["id"]: i for i in ingredients_result.data}

    recipes_by_size: dict[str, list[dict]] = defaultdict(list)
    for r in recipe_rows:
        recipes_by_size[r["product_size_id"]].append(r)

    availability: dict[str, str] = {}
    for psid in product_size_ids:
        recipe = recipes_by_size.get(psid)
        if not recipe:
            availability[psid] = "available"
            continue

        status = "available"
        for item in recipe:
            ingredient = stock_by_ingredient.get(item["ingredient_id"])
            if not ingredient:
                continue
            current_stock = float(ingredient["current_stock"])
            needed = float(item["qty_per_serving"])
            reorder_threshold = float(ingredient["reorder_threshold"])
            if current_stock < needed:
                status = "unavailable"
                break
            if current_stock <= reorder_threshold:
                status = "low_stock"
        availability[psid] = status

    return availability


@router.get("/products", response_model=list[ProductOut])
def list_products(
    active_only: bool = True,
    department: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """No branch scoping (single-branch build) -- every authenticated user
    sees the full catalog. `department` is an optional display filter
    (kitchen/cafe), not an access boundary."""
    supabase = get_supabase()

    query = supabase.table("products").select("*")
    if active_only:
        query = query.eq("active", True)
    if department:
        query = query.eq("department", department)
    products_result = query.order("category").order("name").execute()
    products = products_result.data

    product_ids = [p["id"] for p in products]
    sizes_by_product: dict[str, list[dict]] = defaultdict(list)
    if product_ids:
        sizes_result = (
            supabase.table("product_sizes")
            .select("*")
            .in_("product_id", product_ids)
            .order("sort_order")
            .execute()
        )
        for s in sizes_result.data:
            sizes_by_product[s["product_id"]].append(s)

    all_size_ids = [s["id"] for sizes in sizes_by_product.values() for s in sizes]
    availability = _compute_size_availability(supabase, all_size_ids)

    bundle_size_ids = [s["id"] for p in products if p["is_bundle"] for s in sizes_by_product.get(p["id"], [])]
    total_pieces_by_size: dict[str, int] = {}
    if bundle_size_ids:
        bundle_result = (
            supabase.table("bundle_components")
            .select("product_size_id, total_pieces")
            .in_("product_size_id", bundle_size_ids)
            .execute()
        )
        total_pieces_by_size = {r["product_size_id"]: r["total_pieces"] for r in bundle_result.data}

    out = []
    for p in products:
        sizes = sizes_by_product.get(p["id"], [])
        for s in sizes:
            s["availability"] = availability.get(s["id"], "available")
            s["total_pieces"] = total_pieces_by_size.get(s["id"])
        p["sizes"] = sizes
        out.append(p)
    return out
