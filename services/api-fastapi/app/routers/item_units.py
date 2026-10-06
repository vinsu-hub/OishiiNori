"""Named units of measure per ingredient / station item (migration 0061).

Stock is always stored in the item's base unit; an item unit is a named
multiple of it ("pack = 100 sheets", "mini sheet = 0.25 sheet"). The
dashboard converts on entry, so recipe deduction and every stock number
stay in one consistent unit.
"""

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser, get_current_user, require_role, require_role_or_grant
from app.deps import get_supabase
from app.schemas import ItemUnitCreate, ItemUnitOut

router = APIRouter(tags=["item-units"])

# Same people who can receive stock or edit recipes.
_STOCK_ROLES = ("manager", "executive", "stocker")


@router.get("/item-units", response_model=list[ItemUnitOut])
def list_item_units(user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    return supabase.table("item_units").select("*").order("name").execute().data


@router.post("/item-units", response_model=ItemUnitOut)
def create_item_unit(body: ItemUnitCreate, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "stock", *_STOCK_ROLES, "employee")
    if bool(body.ingredient_id) == bool(body.stock_item_id):
        raise HTTPException(status_code=400, detail="Exactly one of ingredient_id or stock_item_id is required")
    name = " ".join(body.name.split()).lower()
    supabase = get_supabase()
    if body.ingredient_id:
        item = supabase.table("ingredients").select("base_unit").eq("id", body.ingredient_id).maybe_single().execute()
        base = (item.data or {}).get("base_unit") if item else None
        if not item or not item.data:
            raise HTTPException(status_code=404, detail="Ingredient not found")
    else:
        item = supabase.table("stock_items").select("unit").eq("id", body.stock_item_id).maybe_single().execute()
        if not item or not item.data:
            raise HTTPException(status_code=404, detail="Station item not found")
        base = item.data.get("unit") or "pcs"
    if base and name == base.strip().lower():
        raise HTTPException(status_code=400, detail=f"'{name}' is already this item's base unit")
    try:
        created = (
            supabase.table("item_units")
            .insert({
                "ingredient_id": body.ingredient_id,
                "stock_item_id": body.stock_item_id,
                "name": name,
                "base_qty": body.base_qty,
                "created_by": user.id,
            })
            .execute()
        )
    except Exception as e:
        if "duplicate" in str(e).lower() or "23505" in str(e):
            raise HTTPException(status_code=409, detail=f"This item already has a unit called '{name}'")
        raise
    return created.data[0]


@router.delete("/item-units/{unit_id}")
def delete_item_unit(unit_id: str, user: CurrentUser = Depends(get_current_user)):
    # Removing a unit doesn't change any stock (everything is stored in base
    # units); it only stops it being offered. Managers decide that.
    require_role(user, "manager", "executive")
    get_supabase().table("item_units").delete().eq("id", unit_id).execute()
    return {"status": "ok"}
