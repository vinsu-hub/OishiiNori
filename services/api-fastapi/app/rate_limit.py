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
