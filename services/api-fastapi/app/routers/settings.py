"""Business-wide configurable settings (currently just VAT rate). Replaces
the two previously-hardcoded 0.12 constants (transactions.py's VAT_RATE,
the frontend's VAT_RATE_PREVIEW) with one admin-editable source of truth.
"""

from datetime import datetime, timezone

from fastapi import HTTPException, APIRouter, Depends

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.schemas import BusinessSettingsOut, BusinessSettingsUpdate

router = APIRouter(tags=["settings"])


@router.get("/settings/business", response_model=BusinessSettingsOut)
def get_business_settings(user: CurrentUser = Depends(get_current_user)):
    """Any authenticated user can read -- POS Terminal's live tax preview
    needs this, not just executives."""
    supabase = get_supabase()
    result = supabase.table("business_settings").select("*").eq("id", 1).single().execute()
    return result.data


PROMO_PRODUCT = ("Torikatsu Maki", "4 pcs")


def _promo_item_size_id(supabase) -> str:
    rows = (supabase.table("product_sizes").select("id, products!inner(name)")
            .eq("products.name", PROMO_PRODUCT[0]).eq("size_label", PROMO_PRODUCT[1]).limit(1).execute().data)
    if not rows:
        raise HTTPException(status_code=404, detail="Torikatsu Maki 4 pcs is not on the menu")
    return rows[0]["id"]


@router.patch("/settings/business", response_model=BusinessSettingsOut)
def update_business_settings(body: BusinessSettingsUpdate, user: CurrentUser = Depends(get_current_user)):
    sent = body.model_dump(exclude_unset=True)
    receipt_fields = {k: v for k, v in sent.items() if k.startswith("receipt_")}
    # VAT rate and opening hours stay executive-only; the receipt header and
    # footer are everyday shop details a manager can keep up to date.
    if set(sent) - set(receipt_fields):
        require_role(user, "executive")
    else:
        require_role(user, "manager", "executive")
    supabase = get_supabase()
    update_data = {k: v for k, v in sent.items() if v is not None and not k.startswith("receipt_")}
    update_data.update({k: (v.strip() or None) if isinstance(v, str) else None for k, v in receipt_fields.items()})
    if "open_time" in update_data:
        update_data["open_time"] = update_data["open_time"].isoformat()
    if "close_time" in update_data:
        update_data["close_time"] = update_data["close_time"].isoformat()
    if "first_order_promo_enabled" in update_data:
        update_data["first_order_promo_size_id"] = (
            _promo_item_size_id(supabase) if update_data.pop("first_order_promo_enabled") else None)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    update_data["updated_by"] = user.id
    result = supabase.table("business_settings").update(update_data).eq("id", 1).execute()
    return result.data[0]
