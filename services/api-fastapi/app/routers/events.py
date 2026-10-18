"""Events on the website's Events tab, with sign-ups (migration 0078).

Executives (or staff granted the `events` tab) create events, upload a poster,
and switch listing / sign-ups / "slots full" on and off. The public website
reads listed events and posts sign-ups; payment is arranged at the store.
"""

import uuid
from datetime import datetime, timedelta, timezone

from cachetools import TTLCache
from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field, field_validator

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.rate_limit import client_ip, enforce_rate_limit, local_rate_limit, public_cache
from app.schemas import _is_valid_ph_phone

router = APIRouter(tags=["events"])

BUCKET = "event-images"
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024
PUBLIC_CACHE_SECONDS = 60
# Past events stay on the website this long after they start.
SHOW_PAST_DAYS = 30
_public_events_cache: TTLCache = TTLCache(maxsize=1, ttl=PUBLIC_CACHE_SECONDS)


class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    location: str = Field(default="", max_length=300)
    starts_at: datetime
    ends_at: datetime | None = None
    price_label: str | None = Field(default=None, max_length=120)
    listed: bool = True
    signups_open: bool = True
    slots_full: bool = False


class EventPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    location: str | None = Field(default=None, max_length=300)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    price_label: str | None = Field(default=None, max_length=120)
    listed: bool | None = None
    signups_open: bool | None = None
    slots_full: bool | None = None


class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str = Field(min_length=1, max_length=40)
    email: str | None = Field(default=None, max_length=160)
    slots: int = Field(default=1, ge=1, le=20)
    notes: str | None = Field(default=None, max_length=600)
    website: str | None = None  # honeypot

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value: str) -> str:
        if not _is_valid_ph_phone(value):
            raise ValueError("Enter a valid Philippine mobile number")
        return value.strip()


class SignupStatusIn(BaseModel):
    status: str = Field(pattern="^(new|confirmed|cancelled)$")


def _staff(user: CurrentUser) -> None:
    require_role_or_grant(user, "events", "executive")


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def _clear_public_cache() -> None:
    _public_events_cache.clear()


def accepting_signups(event: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    starts = datetime.fromisoformat(str(event["starts_at"]).replace("Z", "+00:00"))
    return bool(event["listed"] and event["signups_open"] and not event["slots_full"] and starts > now)


# ---------------------------------------------------------------- public


@router.get("/public/events")
def public_events(response: Response):
    public_cache(response, PUBLIC_CACHE_SECONDS)
    if "v" not in _public_events_cache:
        since = (datetime.now(timezone.utc) - timedelta(days=SHOW_PAST_DAYS)).isoformat()
        try:
            rows = (get_supabase().table("events")
                    .select("id,title,description,location,starts_at,ends_at,price_label,image_url,signups_open,slots_full,listed")
                    .eq("listed", True).gte("starts_at", since).order("starts_at").execute().data)
        except APIError:
            rows = []  # migration 0078 not applied yet
        now = datetime.now(timezone.utc)
        _public_events_cache["v"] = [
            {**{k: v for k, v in row.items() if k != "listed"}, "accepting_signups": accepting_signups(row, now)}
            for row in rows
        ]
    return _public_events_cache["v"]


@router.post("/public/events/{event_id}/signups")
def public_event_signup(event_id: str, body: SignupIn, request: Request):
    ip = client_ip(request)
    local_rate_limit(f"event-signup:{ip}", limit=5, window_seconds=600)
    if body.website:
        return {"ok": True}  # honeypot: pretend, save nothing
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"event-signup:{ip}", window_seconds=600, limit=5)
    event = supabase.table("events").select("*").eq("id", event_id).limit(1).execute().data
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    event = event[0]
    if not event["listed"]:
        raise HTTPException(status_code=404, detail="Event not found")
    if not accepting_signups(event):
        raise HTTPException(status_code=409, detail="Sign-ups for this event are closed")
    supabase.table("event_signups").insert({
        "event_id": event_id, "name": body.name.strip(), "phone": body.phone,
        "email": (body.email or "").strip() or None, "slots": body.slots,
        "notes": (body.notes or "").strip() or None,
    }).execute()
    return {"ok": True}


# ---------------------------------------------------------------- staff


@router.get("/events")
def list_events(user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    supabase = get_supabase()
    events = supabase.table("events").select("*").order("starts_at", desc=True).execute().data
    signups = supabase.table("event_signups").select("event_id,slots,status").execute().data if events else []
    for event in events:
        mine = [s for s in signups if s["event_id"] == event["id"] and s["status"] != "cancelled"]
        event["signup_count"] = len(mine)
        event["slots_taken"] = sum(s["slots"] for s in mine)
        event["new_signups"] = sum(1 for s in mine if s["status"] == "new")
    return events


@router.get("/events/new-signups")
def new_signup_count(user: CurrentUser = Depends(get_current_user)):
    """Sidebar badge. Zero for anyone without the Events tab."""
    if user.role != "executive" and "events" not in user.extra_pages:
        return {"count": 0}
    try:
        rows = get_supabase().table("event_signups").select("id").eq("status", "new").execute().data
    except APIError:
        return {"count": 0}
    return {"count": len(rows)}


@router.post("/events")
def create_event(body: EventIn, user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    row = body.model_dump()
    row["starts_at"] = _iso(body.starts_at)
    row["ends_at"] = _iso(body.ends_at)
    row["created_by"] = user.id
    created = get_supabase().table("events").insert(row).execute().data[0]
    _clear_public_cache()
    return created


@router.patch("/events/{event_id}")
def update_event(event_id: str, body: EventPatch, user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    changes = body.model_dump(exclude_unset=True)
    for key in ("starts_at", "ends_at"):
        if key in changes:
            changes[key] = _iso(changes[key])
    if not changes:
        raise HTTPException(status_code=400, detail="Nothing to update")
    changes["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = get_supabase().table("events").update(changes).eq("id", event_id).execute().data
    if not updated:
        raise HTTPException(status_code=404, detail="Event not found")
    _clear_public_cache()
    return updated[0]


@router.delete("/events/{event_id}")
def delete_event(event_id: str, user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    get_supabase().table("events").delete().eq("id", event_id).execute()
    _clear_public_cache()
    return {"id": event_id, "deleted": True}


@router.post("/events/{event_id}/image")
async def upload_event_image(event_id: str, file: UploadFile = File(...), user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or WEBP images are allowed")
    contents = await file.read()
    if len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 5MB or smaller")
    supabase = get_supabase()
    if not supabase.table("events").select("id").eq("id", event_id).limit(1).execute().data:
        raise HTTPException(status_code=404, detail="Event not found")
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[file.content_type]
    path = f"{event_id}/{uuid.uuid4()}.{ext}"
    supabase.storage.from_(BUCKET).upload(path, contents, file_options={"content-type": file.content_type})
    url = supabase.storage.from_(BUCKET).get_public_url(path)
    updated = (supabase.table("events").update({"image_url": url, "updated_at": datetime.now(timezone.utc).isoformat()})
               .eq("id", event_id).execute().data)
    _clear_public_cache()
    return updated[0]


@router.get("/events/{event_id}/signups")
def list_signups(event_id: str, user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    return (get_supabase().table("event_signups").select("*").eq("event_id", event_id)
            .order("created_at", desc=True).execute().data)


@router.patch("/event-signups/{signup_id}")
def update_signup(signup_id: str, body: SignupStatusIn, user: CurrentUser = Depends(get_current_user)):
    _staff(user)
    updated = get_supabase().table("event_signups").update({"status": body.status}).eq("id", signup_id).execute().data
    if not updated:
        raise HTTPException(status_code=404, detail="Sign-up not found")
    return updated[0]
