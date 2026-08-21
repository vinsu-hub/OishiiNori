from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import RecipeItemOut

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
