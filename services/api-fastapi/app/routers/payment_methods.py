"""Online payment methods (GCash, Maya, Maribank, ...) for delivery/pickup
checkout on the Customer Menu app. Fully admin-manageable -- unlike POS's
fixed payment-method set, this list can grow/shrink/reorder without a code
change. "Cash" is a separate, hardcoded built-in handled entirely in
digital_menu.py; it never appears as a row here.

Same fetch-then-404, exclude_unset-update, manual require_role() shape as
discounts.py. Delete is a real hard delete (not soft, unlike products/
discount_types) because a placed order denormalizes the method's name onto
itself at order time rather than holding a live FK -- there is nothing for
a delete to orphan.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.auth import CurrentUser, get_current_user, require_role, require_role_or_grant
from app.deps import get_supabase
from app.schemas import OnlinePaymentMethodCreate, OnlinePaymentMethodOut, OnlinePaymentMethodUpdate

router = APIRouter(tags=["payment_methods"])

STORAGE_BUCKET = "payment-qr-codes"
ALLOWED_IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@router.get("/payment-methods", response_model=list[OnlinePaymentMethodOut])
def list_active_payment_methods():
    """Public, no auth -- this is what the Customer Menu checkout fetches
    to render payment-method buttons alongside the built-in Cash option."""
    supabase = get_supabase()
    result = (
        supabase.table("online_payment_methods")
        .select("*")
        .eq("active", True)
        .order("sort_order")
        .execute()
    )
    return result.data


@router.get("/payment-methods/all", response_model=list[OnlinePaymentMethodOut])
def list_all_payment_methods(user: CurrentUser = Depends(get_current_user)):
    """Manager/executive -- includes inactive rows, for the management UI."""
    require_role_or_grant(user, "pos-management", "manager", "executive")
    supabase = get_supabase()
    result = supabase.table("online_payment_methods").select("*").order("sort_order").execute()
    return result.data


@router.post("/payment-methods", response_model=OnlinePaymentMethodOut)
def create_payment_method(body: OnlinePaymentMethodCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    supabase = get_supabase()
    result = (
        supabase.table("online_payment_methods")
        .insert(
            {
                "name": body.name.strip(),
                "account_name": body.account_name.strip(),
                "account_number": body.account_number.strip(),
                "sort_order": body.sort_order,
            }
        )
        .execute()
    )
    return result.data[0]


@router.patch("/payment-methods/{method_id}", response_model=OnlinePaymentMethodOut)
def update_payment_method(
    method_id: str, body: OnlinePaymentMethodUpdate, user: CurrentUser = Depends(get_current_user)
):
    require_role(user, "executive")
    supabase = get_supabase()

    existing = (
        supabase.table("online_payment_methods").select("id").eq("id", method_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Payment method not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = supabase.table("online_payment_methods").update(update_data).eq("id", method_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Payment method not found")
    return result.data[0]


@router.delete("/payment-methods/{method_id}")
def delete_payment_method(method_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    supabase = get_supabase()
    existing = (
        supabase.table("online_payment_methods").select("id").eq("id", method_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Payment method not found")
    supabase.table("online_payment_methods").delete().eq("id", method_id).execute()
    return {"status": "ok"}


@router.post("/payment-methods/{method_id}/qr-code", response_model=OnlinePaymentMethodOut)
async def upload_payment_method_qr_code(
    method_id: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Real file upload to the payment-qr-codes Storage bucket -- identical
    pattern to menu_admin.py's upload_product_image."""
    require_role(user, "executive")
    supabase = get_supabase()

    existing = (
        supabase.table("online_payment_methods").select("id").eq("id", method_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Payment method not found")

    if file.content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or WEBP images are allowed")

    contents = await file.read()
    if len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 5MB or smaller")

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    storage_path = f"{method_id}/{uuid.uuid4()}.{ext}"

    supabase.storage.from_(STORAGE_BUCKET).upload(
        storage_path, contents, file_options={"content-type": file.content_type}
    )
    public_url = supabase.storage.from_(STORAGE_BUCKET).get_public_url(storage_path)

    updated = (
        supabase.table("online_payment_methods")
        .update({"qr_code_url": public_url, "updated_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", method_id)
        .execute()
    )
    return updated.data[0]
