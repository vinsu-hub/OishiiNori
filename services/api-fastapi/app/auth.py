from dataclasses import dataclass

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.deps import get_supabase

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    id: str
    role: str
    department: str | None
    full_name: str | None


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> CurrentUser:
    """Validates the caller's Supabase-issued JWT and loads their role.

    Delegates token verification to Supabase Auth itself (rather than
    re-implementing JWKS/signature checks) so expiry, revocation, and
    signature validation stay centralized in the one place that issues
    these tokens -- same pattern as the SMFC reference's auth.py.

    JUDGMENT CALL: unlike SMFC, there is no branch_id to load or gate on
    (locked scope: single branch). `department` (kitchen/cafe) is loaded
    for display/filtering convenience only -- it is NOT used as an access
    boundary anywhere in this backend, matching the task's instruction that
    the auth gate should check role but not branch. If department-level
    access control turns out to be wanted later, this is the one place to
    add it.
    """
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    supabase = get_supabase()
    try:
        auth_response = supabase.auth.get_user(credentials.credentials)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    if not auth_response or not auth_response.user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user_id = auth_response.user.id

    profile_result = (
        supabase.table("profiles")
        .select("role, department, full_name")
        .eq("id", user_id)
        .single()
        .execute()
    )
    if not profile_result.data:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No profile for this account")

    return CurrentUser(
        id=user_id,
        role=profile_result.data["role"],
        department=profile_result.data.get("department"),
        full_name=profile_result.data.get("full_name"),
    )


def require_role(user: CurrentUser, *roles: str) -> None:
    """Raises 403 unless the caller's role is one of `roles`. No branch
    dimension exists in this build, so this is the entire authorization
    surface beyond "is logged in" (get_current_user)."""
    if user.role not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires one of roles: {', '.join(roles)}",
        )


def verify_employee_pin(employee_number: str, pin: str) -> dict | None:
    """Looks up a profile by kiosk employee_number and bcrypt-verifies pin
    against kiosk_pin_hash. Used by the kiosk router's /kiosk/verify, the
    Owner's Request re-authentication flow in transactions.py, the
    reservation override, and Start/End Business Day -- same primitive as
    the SMFC reference.

    Strips both inputs first: an exact `.eq()` lookup and a bcrypt compare
    both fail silently on a stray leading/trailing space (a real, observed
    cause of "did not match" reports from a tablet's on-screen keyboard or
    autocomplete) -- this is the one shared choke point for every caller,
    so trimming here covers all of them without touching each call site.
    """
    employee_number = employee_number.strip()
    pin = pin.strip()
    supabase = get_supabase()
    result = (
        supabase.table("profiles")
        .select("id, full_name, role, kiosk_pin_hash")
        .eq("employee_number", employee_number)
        .maybe_single()
        .execute()
    )
    if not result or not result.data or not result.data.get("kiosk_pin_hash"):
        return None
    profile = result.data
    if not bcrypt.checkpw(pin.encode("utf-8"), profile["kiosk_pin_hash"].encode("utf-8")):
        return None
    return profile
