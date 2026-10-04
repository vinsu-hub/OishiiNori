"""Lets staff sign in to the dashboard with their employee ID (EMP-xxxx)
instead of their email. The dashboard resolves the ID to the login email
here, then signs in with Supabase Auth as usual -- the password never
passes through this backend.

Public (the user isn't logged in yet), so it's rate-limited per IP, and it
only ever answers for an active employee ID: a login email is already
derivable from a name, so this reveals nothing a coworker couldn't guess.
"""

import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.auth import _profile_active_supported_check, _profile_credentials_supported_check
from app.deps import get_supabase
from app.rate_limit import client_ip, enforce_rate_limit

router = APIRouter(tags=["auth"])

_EMPLOYEE_NUMBER = re.compile(r"^EMP-[0-9A-F]{4}$")


class ResolveLoginRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=64)


class ResolveLoginResponse(BaseModel):
    email: str


@router.post("/auth/resolve-login", response_model=ResolveLoginResponse)
def resolve_login(body: ResolveLoginRequest, request: Request):
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"resolve-login:{client_ip(request)}", window_seconds=60, limit=20)

    employee_number = body.identifier.strip().upper()
    not_found = HTTPException(status_code=404, detail="No active employee with that ID")
    if not _EMPLOYEE_NUMBER.match(employee_number) or not _profile_credentials_supported_check(supabase):
        raise not_found

    columns = "email" + (", active" if _profile_active_supported_check(supabase) else "")
    result = supabase.table("profiles").select(columns).eq("employee_number", employee_number).maybe_single().execute()
    row = result.data if result else None
    if not row or not row.get("email") or row.get("active") is False:
        raise not_found
    return {"email": row["email"]}
