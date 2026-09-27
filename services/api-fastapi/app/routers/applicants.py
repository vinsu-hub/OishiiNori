"""Careers / "Join Our Crew": a public, unauthenticated application form on
the Landing Page (name, phone, email, then an optional resume photo) staged
into a queue that manager/executive staff work through in dashboard-web's
Applicants tab. Same public-submit shape as reviews.py/inquiries.py, reusing
the review-photo upload pattern -- jpg/png only, never PDF, enforced here by
content-type allowlist (the client also restricts the file picker, but that
is only a convenience; this check is the real gate).
"""

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.rate_limit import client_ip, enforce_rate_limit
from app.schemas import ApplicantOut, ApplicantStatus, CreateApplicantRequest, UpdateApplicantRequest

router = APIRouter(tags=["applicants"])


def _fetch_applicant(supabase, applicant_id: str) -> dict:
    result = supabase.table("job_applicants").select("*").eq("id", applicant_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Application not found")
    return result.data


@router.post("/public/applicants", response_model=ApplicantOut)
def submit_applicant(body: CreateApplicantRequest, request: Request):
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"applicant-submit:{client_ip(request)}", window_seconds=600, limit=5)
    if body.website:
        raise HTTPException(status_code=400, detail="Submission rejected")
    payload = {
        "full_name": body.full_name.strip(),
        "phone": body.phone.strip(),
        "email": body.email.strip(),
        "position_interest": (body.position_interest or "").strip() or None,
        "message": (body.message or "").strip() or None,
    }
    result = supabase.table("job_applicants").insert(payload).execute()
    return result.data[0]


APPLICANT_PHOTO_BUCKET = "applicant-photos"
# Strictly jpg/png -- no PDF, no other image type. The dashboard shows this as
# a photo, not a downloadable document.
APPLICANT_PHOTO_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png"}
APPLICANT_PHOTO_MAX_BYTES = 8 * 1024 * 1024


@router.post("/public/applicants/{applicant_id}/photo", response_model=ApplicantOut)
async def upload_applicant_photo(applicant_id: str, file: UploadFile = File(...)):
    """Unauthenticated, same trust model as reviews.py's photo upload -- the
    application's own unguessable id is the entire access control. Optional
    second step after POST /public/applicants; a submission that never gets a
    photo attached is still a complete, valid application."""
    supabase = get_supabase()
    applicant = _fetch_applicant(supabase, applicant_id)
    if applicant["status"] != "new":
        raise HTTPException(status_code=400, detail="This application has already been reviewed")

    if file.content_type not in APPLICANT_PHOTO_ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Only JPG or PNG images are allowed -- no PDF")

    contents = await file.read()
    if len(contents) > APPLICANT_PHOTO_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 8MB or smaller")

    ext = "png" if file.content_type == "image/png" else "jpg"
    storage_path = f"{applicant_id}/{uuid.uuid4()}.{ext}"

    supabase.storage.from_(APPLICANT_PHOTO_BUCKET).upload(
        storage_path, contents, file_options={"content-type": file.content_type}
    )
    public_url = supabase.storage.from_(APPLICANT_PHOTO_BUCKET).get_public_url(storage_path)

    updated = supabase.table("job_applicants").update({"resume_photo_url": public_url}).eq("id", applicant_id).execute()
    return updated.data[0]


@router.get("/applicants", response_model=list[ApplicantOut])
def list_applicants(
    status: ApplicantStatus | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    require_role_or_grant(user, "applicants", "manager", "executive")
    supabase = get_supabase()
    query = supabase.table("job_applicants").select("*")
    if status:
        query = query.eq("status", status)
    return query.order("created_at", desc=True).limit(500).execute().data


@router.patch("/applicants/{applicant_id}", response_model=ApplicantOut)
def update_applicant(applicant_id: str, body: UpdateApplicantRequest, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "applicants", "manager", "executive")
    supabase = get_supabase()
    _fetch_applicant(supabase, applicant_id)
    updated = (
        supabase.table("job_applicants")
        .update({"status": body.status, "decided_by": user.id})
        .eq("id", applicant_id)
        .execute()
    )
    return updated.data[0]
