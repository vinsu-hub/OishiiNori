"""Customer Reviews: a public, unauthenticated submission from the Landing
Page (star rating + up to 600 chars, named or anonymous) staged into a
`pending` queue -- same "public submit -> staff approve/reject" shape as
digital_orders/reservations, reusing that pattern's rate-limiting and
idempotency-key helpers rather than inventing a new one. Admin-only for
now: an approved review is never surfaced anywhere public, this is purely
an internal moderation/record-keeping queue.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.idempotency import check_idempotency_key, record_idempotency_key
from app.rate_limit import client_ip, enforce_rate_limit
from app.schemas import CreateReviewRequest, RejectReviewRequest, ReviewOut, ReviewStatus

router = APIRouter(tags=["reviews"])


def _valid_idempotency_key(key: str | None) -> str | None:
    """idempotency_keys.key is a uuid column (migration 0048) but every
    caller's own schema types this field as a plain str -- an unvalidated
    non-uuid value reaches check_idempotency_key's insert/select and 500s
    with a raw Postgres type error instead of degrading. A malformed key
    is treated the same as no key at all (idempotency is a convenience for
    a well-behaved client, not something worth failing the whole
    submission over)."""
    if not key:
        return None
    try:
        uuid.UUID(key)
    except ValueError:
        return None
    return key


@router.post("/public/reviews", response_model=ReviewOut)
def submit_review(body: CreateReviewRequest, request: Request):
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"review-submit:{client_ip(request)}", window_seconds=60, limit=5)
    idempotency_key = _valid_idempotency_key(body.idempotency_key)
    existing_id = check_idempotency_key(supabase, idempotency_key, "POST /public/reviews")
    if existing_id:
        return _fetch_review(supabase, existing_id)

    if not body.is_anonymous and not (body.customer_name or "").strip():
        raise HTTPException(status_code=400, detail="Name is required unless posting anonymously")

    insert_payload = {
        "is_anonymous": body.is_anonymous,
        # Never persisted for an anonymous review, regardless of what the
        # client sent -- a privacy guarantee enforced here, not just a UI
        # convention the client could bypass.
        "customer_name": None if body.is_anonymous else body.customer_name.strip(),
        "rating": body.rating,
        "body": body.body.strip(),
    }
    result = supabase.table("reviews").insert(insert_payload).execute()
    review = result.data[0]
    record_idempotency_key(supabase, idempotency_key, "POST /public/reviews", review["id"])
    return review


def _fetch_review(supabase, review_id: str) -> dict:
    result = supabase.table("reviews").select("*").eq("id", review_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Review not found")
    return result.data


REVIEW_PHOTO_BUCKET = "review-photos"
REVIEW_PHOTO_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
REVIEW_PHOTO_MAX_BYTES = 5 * 1024 * 1024


@router.post("/public/reviews/{review_id}/photo", response_model=ReviewOut)
async def upload_review_photo(review_id: str, file: UploadFile = File(...)):
    """Unauthenticated, same trust model as digital_menu.py's
    upload_proof_of_payment -- the review's own unguessable id is the
    entire access control. Only allowed while still pending, so a decided
    review's record can't be tampered with after the fact. Optional, second
    step after POST /public/reviews -- a review that never gets a photo
    attached (the upload never happens, or fails) is still a complete,
    valid review; this never blocks or reverses the submission itself."""
    supabase = get_supabase()
    review = _fetch_review(supabase, review_id)
    if review["status"] != "pending":
        raise HTTPException(
            status_code=400, detail=f"Review is already {review['status']} -- a photo can no longer be attached"
        )

    if file.content_type not in REVIEW_PHOTO_ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or WEBP images are allowed")

    contents = await file.read()
    if len(contents) > REVIEW_PHOTO_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 5MB or smaller")

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    storage_path = f"{review_id}/{uuid.uuid4()}.{ext}"

    supabase.storage.from_(REVIEW_PHOTO_BUCKET).upload(
        storage_path, contents, file_options={"content-type": file.content_type}
    )
    public_url = supabase.storage.from_(REVIEW_PHOTO_BUCKET).get_public_url(storage_path)

    updated = supabase.table("reviews").update({"photo_url": public_url}).eq("id", review_id).execute()
    return updated.data[0]


@router.get("/reviews", response_model=list[ReviewOut])
def list_reviews(
    status: ReviewStatus | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Manager/executive only -- the Customer Reviews tab. Gated
    server-side (unlike the older digital-orders queue, which relies on
    Sidebar-only gating) since a review carries a customer's real name."""
    require_role_or_grant(user, "reviews", "manager", "executive")
    supabase = get_supabase()
    query = supabase.table("reviews").select("*")
    if status:
        query = query.eq("status", status)
    return query.order("created_at", desc=True).execute().data


def _fetch_pending_review(supabase, review_id: str) -> dict:
    review = _fetch_review(supabase, review_id)
    if review["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Review is already {review['status']}")
    return review


@router.post("/reviews/{review_id}/approve", response_model=ReviewOut)
def approve_review(review_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "reviews", "manager", "executive")
    supabase = get_supabase()
    _fetch_pending_review(supabase, review_id)

    updated = (
        supabase.table("reviews")
        .update({"status": "approved", "decided_by": user.id, "decided_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", review_id)
        .execute()
    )
    return updated.data[0]


@router.post("/reviews/{review_id}/reject", response_model=ReviewOut)
def reject_review(review_id: str, body: RejectReviewRequest, user: CurrentUser = Depends(get_current_user)):
    require_role_or_grant(user, "reviews", "manager", "executive")
    if not body.reason.strip():
        raise HTTPException(status_code=400, detail="A reason is required")
    supabase = get_supabase()
    _fetch_pending_review(supabase, review_id)

    updated = (
        supabase.table("reviews")
        .update(
            {
                "status": "rejected",
                "rejected_reason": body.reason.strip(),
                "decided_by": user.id,
                "decided_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .eq("id", review_id)
        .execute()
    )
    return updated.data[0]
