"""Shared rate-limiting helper for the public/unauthenticated endpoints most
exposed to a scripted flood (kiosk PIN verify, public reservation/order
submission, availability lookups). See migration 0049_rate_limit_counters.sql
for why the check+increment is a single atomic Postgres RPC rather than an
in-process counter -- this backend runs as Vercel serverless functions, and
an in-memory limiter would not be shared across concurrent container
instances.
"""

from fastapi import HTTPException, Request


def client_ip(request: Request) -> str:
    """Vercel's edge sets X-Forwarded-For; request.client.host is the
    fallback for local dev (uvicorn sees the real socket peer directly)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce_rate_limit(supabase, key: str, window_seconds: int, limit: int) -> None:
    """Raises 429 once `key` has been seen more than `limit` times within
    the current `window_seconds`-wide bucket. Call this first, before any
    other work, on an endpoint that needs it."""
    result = supabase.rpc(
        "check_rate_limit",
        {"p_key": key, "p_window_seconds": window_seconds, "p_limit": limit},
    ).execute()
    allowed = result.data if isinstance(result.data, bool) else bool(result.data)
    if not allowed:
        raise HTTPException(status_code=429, detail="Too many requests -- please try again shortly")


# ---------------------------------------------------------------------------
# First line of defence: an in-memory limiter per server instance. It isn't
# shared between instances (see above), so it never replaces the database
# limiter on writes -- but a flood from one client mostly lands on the same
# warm instance, and this refuses it without a Supabase request (each of
# which costs egress and a log line on the free plan). Read-only public
# endpoints use only this one.
# ---------------------------------------------------------------------------
import threading
import time
from collections import OrderedDict

_local_hits: "OrderedDict[str, tuple[float, int]]" = OrderedDict()
_local_lock = threading.Lock()
_LOCAL_MAX_KEYS = 5000


def local_rate_limit(key: str, limit: int, window_seconds: int) -> None:
    """Raises 429 once `key` is seen more than `limit` times in the current
    fixed `window_seconds` window on this instance."""
    now = time.monotonic()
    with _local_lock:
        start, count = _local_hits.get(key, (now, 0))
        if now - start >= window_seconds:
            start, count = now, 0
        count += 1
        _local_hits[key] = (start, count)
        _local_hits.move_to_end(key)
        while len(_local_hits) > _LOCAL_MAX_KEYS:
            _local_hits.popitem(last=False)
    if count > limit:
        raise HTTPException(status_code=429, detail="Too many requests -- please try again shortly")


def public_cache(response, seconds: int) -> None:
    """Lets Vercel's CDN answer repeat visitors for `seconds` (and serve a
    stale copy while refreshing), so busy public pages don't run Python or
    touch Supabase on every view."""
    response.headers["Cache-Control"] = f"public, max-age=0, s-maxage={seconds}, stale-while-revalidate=300"
