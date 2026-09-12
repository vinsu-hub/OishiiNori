import time
from dataclasses import dataclass

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from supabase_auth.errors import AuthRetryableError

from app.deps import get_supabase

bearer_scheme = HTTPBearer(auto_error=False)

# Feature detection for migration 0040 (profiles.active) -- same
# fail-open-until-migrated pattern transactions.py uses throughout, so
# deploying this code doesn't break every authenticated request the
# moment it ships, before the migration is hand-applied.
_profile_active_supported: bool | None = None


def _profile_active_supported_check(supabase) -> bool:
    global _profile_active_supported
    if _profile_active_supported is None:
        try:
            supabase.table("profiles").select("active").limit(1).execute()
            _profile_active_supported = True
        except Exception:
            _profile_active_supported = False
    return _profile_active_supported


# Feature detection for migration 0043 (profiles.extra_pages) -- same
# fail-open-until-migrated pattern as _profile_active_supported_check above.
_profile_extra_pages_supported: bool | None = None


def _profile_extra_pages_supported_check(supabase) -> bool:
    global _profile_extra_pages_supported
    if _profile_extra_pages_supported is None:
        try:
            supabase.table("profiles").select("extra_pages").limit(1).execute()
            _profile_extra_pages_supported = True
        except Exception:
            _profile_extra_pages_supported = False
    return _profile_extra_pages_supported


# Feature detection for migration 0044 (profiles.email/current_password/
# current_pin) -- same fail-open-until-migrated pattern as above.
_profile_credentials_supported: bool | None = None


def _profile_credentials_supported_check(supabase) -> bool:
    global _profile_credentials_supported
    if _profile_credentials_supported is None:
        try:
            supabase.table("profiles").select("email").limit(1).execute()
            _profile_credentials_supported = True
        except Exception:
            _profile_credentials_supported = False
    return _profile_credentials_supported


@dataclass
class CurrentUser:
    id: str
    role: str
    department: str | None
    full_name: str | None
    extra_pages: list[str]


def _get_user_with_retry(supabase, token: str):
    """supabase_auth wraps any non-HTTP-status exception talking to its
    server (timeout, connection reset) -- and 502/503/504/520-524/530
    upstream responses -- as AuthRetryableError, distinct from AuthApiError
    (a real bad/expired JWT). Observed in production: a handful of
    otherwise-valid requests getting misreported as 401 during a brief
    Supabase connection blip. One retry, same reasoning as
    _RetryOnDisconnectTransport in deps.py -- a GET is safe to repeat.
    """
    try:
        return supabase.auth.get_user(token)
    except AuthRetryableError:
        time.sleep(0.25)
        return supabase.auth.get_user(token)


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
        auth_response = _get_user_with_retry(supabase, credentials.credentials)
    except AuthRetryableError:
        # A transient network blip talking to Supabase Auth (timeout,
        # connection reset, a 502/503/504 from its own upstream) -- not the
        # caller's fault, so don't tell them their token is invalid (that
        # reads as "you're logged out" and can trigger an unwanted client-
        # side logout/redirect). 503 signals "try again," not "re-auth."
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Auth service temporarily unavailable")
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    if not auth_response or not auth_response.user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user_id = auth_response.user.id

    active_supported = _profile_active_supported_check(supabase)
    extra_pages_supported = _profile_extra_pages_supported_check(supabase)
    columns = (
        "role, department, full_name"
        + (", active" if active_supported else "")
        + (", extra_pages" if extra_pages_supported else "")
    )
    profile_result = (
        supabase.table("profiles")
        .select(columns)
        .eq("id", user_id)
        .single()
        .execute()
    )
    if not profile_result.data:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No profile for this account")
    if active_supported and profile_result.data.get("active") is False:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account has been deactivated")

    return CurrentUser(
        id=user_id,
        role=profile_result.data["role"],
        department=profile_result.data.get("department"),
        full_name=profile_result.data.get("full_name"),
        extra_pages=profile_result.data.get("extra_pages") or [],
    )


def require_role(user: CurrentUser, *roles: str) -> None:
    """Raises 403 unless the caller's role is one of `roles`. No branch
    dimension exists in this build, so beyond "is logged in"
    (get_current_user), this and require_role_or_grant below are the entire
    authorization surface."""
    if user.role not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires one of roles: {', '.join(roles)}",
        )


def require_role_or_grant(user: CurrentUser, page_key: str, *roles: str) -> None:
    """Same as require_role, but also passes if the caller was individually
    granted this specific tab (profiles.extra_pages) -- additive on top of
    the role floor, never a replacement for it. Used for a tab's baseline
    gate only; a page's stricter nested executive-only sub-actions (e.g.
    Employees' hard-delete, POS Management's payment-method CRUD) keep using
    plain require_role so a grant here can never reach further than what a
    real manager already sees on that page."""
    if user.role in roles or page_key in user.extra_pages:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Requires one of roles: {', '.join(roles)}, or a grant for '{page_key}'",
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
    active_supported = _profile_active_supported_check(supabase)
    columns = "id, full_name, role, kiosk_pin_hash" + (", active" if active_supported else "")
    result = (
        supabase.table("profiles")
        .select(columns)
        .eq("employee_number", employee_number)
        .maybe_single()
        .execute()
    )
    if not result or not result.data or not result.data.get("kiosk_pin_hash"):
        return None
    profile = result.data
    if active_supported and profile.get("active") is False:
        return None
    if not bcrypt.checkpw(pin.encode("utf-8"), profile["kiosk_pin_hash"].encode("utf-8")):
        return None
    return profile
