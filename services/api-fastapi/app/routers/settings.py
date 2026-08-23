"""Business-wide configurable settings (currently just VAT rate). Replaces
the two previously-hardcoded 0.12 constants (transactions.py's VAT_RATE,
the frontend's VAT_RATE_PREVIEW) with one admin-editable source of truth.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends

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


@router.patch("/settings/business", response_model=BusinessSettingsOut)
def update_business_settings(body: BusinessSettingsUpdate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    supabase = get_supabase()
    result = (
        supabase.table("business_settings")
        .update(
            {
                "vat_rate": body.vat_rate,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "updated_by": user.id,
            }
        )
        .eq("id", 1)
        .execute()
    )
    return result.data[0]
