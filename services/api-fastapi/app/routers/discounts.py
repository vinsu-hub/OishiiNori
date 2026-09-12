from datetime import datetime, timezone

from cachetools import TTLCache
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.schemas import DiscountTypeCreate, DiscountTypeOut, DiscountTypeUpdate

router = APIRouter(tags=["discounts"])

# Discount types change only via occasional manager edits but are read on
# every POS checkout render -- short TTL, same rationale as products.py.
_discount_types_cache: TTLCache = TTLCache(maxsize=4, ttl=5)


@router.get("/discount-types", response_model=list[DiscountTypeOut])
def list_discount_types(active_only: bool = Query(False), user: CurrentUser = Depends(get_current_user)):
    """Any logged-in user can read -- POS checkout needs these to render the
    discount buttons, not just managers."""
    cached = _discount_types_cache.get(active_only)
    if cached is not None:
        return cached

    supabase = get_supabase()
    query = supabase.table("discount_types").select("*")
    if active_only:
        query = query.eq("active", True)
    result = query.order("name").execute()
    _discount_types_cache[active_only] = result.data
    return result.data


@router.post("/discount-types", response_model=DiscountTypeOut)
def create_discount_type(body: DiscountTypeCreate, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "pos-management", "manager", "executive")
    supabase = get_supabase()
    result = (
        supabase.table("discount_types")
        .insert({"name": body.name, "percentage": body.percentage, "vat_exempt": body.vat_exempt})
        .execute()
    )
    return result.data[0]


@router.patch("/discount-types/{discount_type_id}", response_model=DiscountTypeOut)
def update_discount_type(
    discount_type_id: str,
    body: DiscountTypeUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    require_role_or_grant(user, "pos-management", "manager", "executive")
    supabase = get_supabase()

    existing = (
        supabase.table("discount_types").select("id").eq("id", discount_type_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Discount type not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = supabase.table("discount_types").update(update_data).eq("id", discount_type_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Discount type not found")
    return result.data[0]
