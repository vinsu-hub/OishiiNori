"""Website inquiries: a public, unauthenticated Contact / Catering form on
the Landing Page staged into an inbox that manager/executive staff work
through in dashboard-web's Inquiries tab (new -> handled). Same public-submit
shape as reviews.py, reusing its rate limiter. Email notification to the
restaurant is a deliberate follow-up once a professional address exists.
"""

from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.rate_limit import client_ip, enforce_rate_limit

router = APIRouter(tags=["inquiries"])

InquiryKind = Literal["contact", "catering"]
InquiryStatus = Literal["new", "handled"]


class CreateInquiryRequest(BaseModel):
    kind: InquiryKind
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    phone: str | None = Field(default=None, max_length=40)
    message: str = Field(min_length=1, max_length=2000)
    event_date: date | None = None
    guest_count: int | None = Field(default=None, ge=1, le=100000)
    # Honeypot: a hidden field real users never fill; bots do. Silently
    # accepted-and-dropped so a bot gets no signal to adapt to.
    website: str | None = None


class InquiryOut(BaseModel):
    id: str
    kind: InquiryKind
    name: str
    email: str
    phone: str | None = None
    message: str
    event_date: date | None = None
    guest_count: int | None = None
    status: InquiryStatus
    handled_by: str | None = None
    handled_at: str | None = None
    created_at: str


class UpdateInquiryRequest(BaseModel):
    status: InquiryStatus


class InquirySubmitResult(BaseModel):
    ok: bool = True


@router.post("/public/inquiries", response_model=InquirySubmitResult)
def submit_inquiry(body: CreateInquiryRequest, request: Request):
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"inquiry-submit:{client_ip(request)}", window_seconds=600, limit=5)
    if body.website:
        return InquirySubmitResult()
    payload = {
        "kind": body.kind,
        "name": body.name.strip(),
        "email": body.email.strip(),
        "phone": (body.phone or "").strip() or None,
        "message": body.message.strip(),
        "event_date": body.event_date.isoformat() if body.event_date else None,
        "guest_count": body.guest_count,
    }
    if not payload["name"] or not payload["message"]:
        raise HTTPException(status_code=400, detail="Name and message are required")
    supabase.table("inquiries").insert(payload).execute()
    return InquirySubmitResult()


@router.get("/inquiries", response_model=list[InquiryOut])
def list_inquiries(
    status: InquiryStatus | None = Query(None),
    kind: InquiryKind | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    require_role_or_grant(user, "inquiries", "manager", "executive")
    supabase = get_supabase()
    query = supabase.table("inquiries").select("*")
    if status:
        query = query.eq("status", status)
    if kind:
        query = query.eq("kind", kind)
    return query.order("created_at", desc=True).limit(500).execute().data


@router.patch("/inquiries/{inquiry_id}", response_model=InquiryOut)
def update_inquiry(inquiry_id: str, body: UpdateInquiryRequest, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "inquiries", "manager", "executive")
    supabase = get_supabase()
    handled = body.status == "handled"
    updated = (
        supabase.table("inquiries")
        .update(
            {
                "status": body.status,
                "handled_by": user.id if handled else None,
                "handled_at": datetime.now(timezone.utc).isoformat() if handled else None,
            }
        )
        .eq("id", inquiry_id)
        .execute()
    )
    if not updated.data:
        raise HTTPException(status_code=404, detail="Inquiry not found")
    return updated.data[0]
