"""Executive override key (0076): each executive sets their own, after
re-entering their kiosk ID and PIN. It authorizes permanent order erase
(POST /transactions/{id}/erase). The key itself is never returned."""

import bcrypt
from fastapi import APIRouter, Depends, HTTPException
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from app.auth import CurrentUser, get_current_user, require_role, verify_employee_pin
from app.deps import get_supabase

router = APIRouter(tags=["override-key"])


class OverrideKeyIn(BaseModel):
    employee_number: str = Field(min_length=1)
    pin: str = Field(min_length=1)
    new_key: str = Field(min_length=6, max_length=200)


@router.get("/profiles/me/override-key")
def override_key_status(user: CurrentUser = Depends(get_current_user)):
    if user.role != "executive":
        return {"is_set": False}
    try:
        row = (get_supabase().table("profiles").select("override_key_hash")
               .eq("id", user.id).maybe_single().execute())
    except APIError:
        return {"is_set": False}
    return {"is_set": bool(row and (row.data or {}).get("override_key_hash"))}


@router.post("/profiles/me/override-key")
def set_override_key(body: OverrideKeyIn, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    profile = verify_employee_pin(body.employee_number, body.pin)
    if not profile or profile["id"] != user.id:
        raise HTTPException(status_code=403, detail="Employee number/PIN did not match your logged-in account")
    key = body.new_key.strip()
    if len(key) < 6:
        raise HTTPException(status_code=400, detail="Use at least 6 characters")
    hashed = bcrypt.hashpw(key.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    get_supabase().table("profiles").update({"override_key_hash": hashed}).eq("id", user.id).execute()
    return {"is_set": True}
