"""Shared idempotency-key helper for the public/unauthenticated write
endpoints most exposed to a flaky connection (POST /transactions,
POST /public/orders, POST /public/reservations). See migration
0048_idempotency_keys.sql for why this exists: a request can succeed
server-side but lose its response in transit, and a naive retry/offline-
queue replay of that same submission would otherwise create a duplicate.

A client generates one uuid per submission attempt and resends the SAME key
on every retry/replay of that attempt. `check` short-circuits a caller
straight to the original resource on a repeat; `record` is called once,
right after the resource is actually created.
"""

from typing import Optional

from postgrest.exceptions import APIError


def check_idempotency_key(supabase, key: Optional[str], endpoint: str) -> Optional[str]:
    """Returns the resource_id already created for this key+endpoint, or
    None if this is a new submission (or no key was sent at all -- callers
    that don't opt in keep today's exact behavior)."""
    if not key:
        return None
    result = (
        supabase.table("idempotency_keys")
        .select("resource_id")
        .eq("key", key)
        .eq("endpoint", endpoint)
        .maybe_single()
        .execute()
    )
    return result.data["resource_id"] if result and result.data else None


def record_idempotency_key(supabase, key: Optional[str], endpoint: str, resource_id: str) -> None:
    """Best-effort: a genuinely concurrent double-send racing this same key
    to the DB at once is fine (the second insert's unique-violation is
    swallowed) -- the resource itself was already created safely by that
    point, this table only prevents a *third*, later replay from creating
    another one."""
    if not key:
        return
    try:
        supabase.table("idempotency_keys").insert(
            {"key": key, "endpoint": endpoint, "resource_id": resource_id}
        ).execute()
    except APIError as e:
        if e.code != "23505":
            raise
