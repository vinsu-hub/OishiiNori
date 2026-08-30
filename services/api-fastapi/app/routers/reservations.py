"""Table reservations: a public request-a-table flow (mirrors digital_menu.py's
public-submission + staff-approval shape) backed by a real `tables` entity so
availability can be enforced automatically instead of left to staff judgment
(digital_orders.table_number was deliberately left as a bare, unmanaged int --
this is the point where a real table concept was finally needed).

Slot-holding happens at submission time, not confirm time: a `pending`
reservation occupies its table+time window exactly like `confirmed` does.
Only `declined`/`cancelled` free the slot -- see _fetch_occupied_map/
_first_available below. This means a second overlapping request is rejected
(or routed to a different table) the moment it's submitted, so confirm/
decline/cancel are pure business decisions, never conflict re-checks.
"""

from datetime import date, datetime, time, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role, verify_employee_pin
from app.deps import get_supabase
from app.ph_time import PH_UTC_OFFSET
from app.schemas import (
    _LAYOUT_FIELDS,
    CreateReservationRequest,
    DeclineReservationRequest,
    PosTableOverrideRequest,
    PosTableOverrideResponse,
    PosTableOverview,
    PosTableStatusResponse,
    PublicBusinessHoursResponse,
    ReservationAvailabilityResponse,
    ReservationOut,
    ReservationSlotOut,
    ReservationStatusResponse,
    TableCreate,
    TableOut,
    TableUpdate,
)

router = APIRouter(tags=["reservations"])

# Hardcoded, not a business_settings field -- nothing else in this system
# needs to read or vary this per-restaurant, unlike vat_rate (which was
# hoisted into business_settings only because it was literally duplicated
# in two files and needed admin editing). Matches 0023's own stated
# minimalism: don't add a settings field nothing needs yet.
RESERVATION_DURATION_MINUTES = 90
SLOT_GRANULARITY_MINUTES = 30

# The POS holds a confirmed reservation's table starting this many minutes
# before the stated start_time, so staff keep it clear for the guest's
# arrival. The block still ends exactly at end_time (no post-grace).
RESERVATION_PREP_BUFFER_MINUTES = 15

_HOLDING_STATUSES = ["pending", "confirmed"]


# ---------------------------------------------------------------------------
# Availability engine
# ---------------------------------------------------------------------------


def _time_add_minutes(t: time, minutes: int) -> time:
    total = t.hour * 60 + t.minute + minutes
    return time(hour=(total // 60) % 24, minute=total % 60)


def _overlaps(start_a: time, end_a: time, start_b: time, end_b: time) -> bool:
    return start_a < end_b and start_b < end_a


def _get_business_hours(supabase) -> tuple[time, time, list[int]]:
    row = (
        supabase.table("business_settings")
        .select("open_time, close_time, closed_weekdays")
        .eq("id", 1)
        .single()
        .execute()
        .data
    )
    open_time = time.fromisoformat(row["open_time"])
    close_time = time.fromisoformat(row["close_time"])
    return open_time, close_time, row["closed_weekdays"] or []


def _fetch_capacity_candidates(supabase, party_size: int) -> list[dict]:
    """Active tables that fit, smallest-capacity-first (best-fit -- a party
    of 2 shouldn't consume an 8-top if a 2-4 top is free)."""
    return (
        supabase.table("tables")
        .select("id, label, capacity")
        .eq("active", True)
        .gte("capacity", party_size)
        .order("capacity")
        .execute()
        .data
    )


def _fetch_occupied_map(supabase, table_ids: list[str], reservation_date: date) -> dict[str, list[tuple[time, time]]]:
    """One query for the whole date, reused across every slot in the
    availability listing. Pending AND confirmed both count as occupying
    (the locked slot-holding decision); only declined/cancelled are
    excluded via the .in_() filter."""
    if not table_ids:
        return {}
    rows = (
        supabase.table("reservations")
        .select("table_id, start_time, end_time")
        .in_("table_id", table_ids)
        .eq("reservation_date", reservation_date.isoformat())
        .in_("status", _HOLDING_STATUSES)
        .execute()
        .data
    )
    occupied: dict[str, list[tuple[time, time]]] = {}
    for r in rows:
        occupied.setdefault(r["table_id"], []).append(
            (time.fromisoformat(r["start_time"]), time.fromisoformat(r["end_time"]))
        )
    return occupied


def _first_available(candidates: list[dict], occupied: dict, start: time, end: time) -> Optional[dict]:
    """Pure-Python overlap check -- Supabase's REST query builder can't
    express 'start < :end AND end > :start' as a single filter chain
    against two columns, so equality/date pruning happens in SQL
    (_fetch_occupied_map) and the actual overlap arithmetic happens here,
    same 'narrow in SQL, finish in Python' idiom stock_items.py's
    get_low_stock_stock_items uses for its own threshold comparison."""
    for table in candidates:
        conflicts = occupied.get(table["id"], [])
        if not any(_overlaps(start, end, s, e) for s, e in conflicts):
            return table
    return None


def _to_reservation_out(row: dict) -> dict:
    table = row.pop("tables", None) or {}
    row["table_label"] = table.get("label")
    row["overrides"] = row.pop("reservation_overrides", None) or []
    return row


def _now_ph() -> datetime:
    """Current wall-clock in the Philippines, as a naive datetime -- the
    reservations table stores plain date/time, so comparisons happen in PH
    local terms (same convention as ph_time.today_ph)."""
    return (datetime.now(timezone.utc) + PH_UTC_OFFSET).replace(tzinfo=None)


def _table_by_pos_number(supabase, pos_table_number: int) -> Optional[dict]:
    result = (
        supabase.table("tables")
        .select("id, label, capacity, capacity_min, capacity_max, active, pos_table_number")
        .eq("pos_table_number", pos_table_number)
        .maybe_single()
        .execute()
    )
    return result.data if result and result.data else None


def _blocking_reservation(supabase, table_id: str, at: datetime) -> Optional[dict]:
    """The confirmed reservation (if any) that blocks `table_id` at PH-local
    datetime `at`: same calendar date, and `at`'s time falls in
    [start_time - prep buffer, end_time)."""
    at_date = at.date()
    at_time = at.time().replace(second=0, microsecond=0)
    rows = (
        supabase.table("reservations")
        .select("id, reservation_number, customer_name, party_size, start_time, end_time")
        .eq("table_id", table_id)
        .eq("reservation_date", at_date.isoformat())
        .eq("status", "confirmed")
        .execute()
        .data
    )
    for r in rows:
        start = _time_add_minutes(time.fromisoformat(r["start_time"]), -RESERVATION_PREP_BUFFER_MINUTES)
        end = time.fromisoformat(r["end_time"])
        # The buffered window can run past midnight (late close + a near-close
        # start); when it wraps, end < start and "inside" means at >= start OR
        # at < end. (A booking whose start date is yesterday isn't matched here
        # -- reservation_date is filtered to `at`'s date -- which is fine for
        # the realistic same-evening case this guards.)
        inside = start <= at_time < end if start <= end else (at_time >= start or at_time < end)
        if inside:
            return r
    return None


# ---------------------------------------------------------------------------
# Public (unauthenticated) -- the booking flow
# ---------------------------------------------------------------------------


@router.get("/public/business-hours", response_model=PublicBusinessHoursResponse)
def public_business_hours():
    open_time, close_time, closed_weekdays = _get_business_hours(get_supabase())
    return {"open_time": open_time, "close_time": close_time, "closed_weekdays": closed_weekdays}


@router.get("/public/tables/availability", response_model=ReservationAvailabilityResponse)
def public_availability(reservation_date: date = Query(..., alias="date"), party_size: int = Query(..., gt=0)):
    supabase = get_supabase()
    open_time, close_time, closed_weekdays = _get_business_hours(supabase)

    if reservation_date.weekday() in closed_weekdays:
        return {"date": reservation_date, "party_size": party_size, "closed": True, "slots": []}

    candidates = _fetch_capacity_candidates(supabase, party_size)
    occupied = _fetch_occupied_map(supabase, [c["id"] for c in candidates], reservation_date)

    slots: list[dict] = []
    t = open_time
    while _time_add_minutes(t, RESERVATION_DURATION_MINUTES) <= close_time:
        end = _time_add_minutes(t, RESERVATION_DURATION_MINUTES)
        available = bool(candidates) and _first_available(candidates, occupied, t, end) is not None
        slots.append({"time": t.strftime("%H:%M"), "available": available})
        t = _time_add_minutes(t, SLOT_GRANULARITY_MINUTES)

    return {"date": reservation_date, "party_size": party_size, "closed": False, "slots": slots}


@router.post("/public/reservations", response_model=ReservationStatusResponse)
def submit_reservation(body: CreateReservationRequest):
    supabase = get_supabase()
    open_time, close_time, closed_weekdays = _get_business_hours(supabase)

    if body.reservation_date.weekday() in closed_weekdays:
        raise HTTPException(status_code=400, detail="We're closed on this day")

    end_time = _time_add_minutes(body.start_time, RESERVATION_DURATION_MINUTES)
    if body.start_time < open_time or end_time > close_time:
        raise HTTPException(status_code=400, detail="Outside business hours for this reservation length")

    candidates = _fetch_capacity_candidates(supabase, body.party_size)
    if not candidates:
        raise HTTPException(status_code=400, detail="No table can seat this party size")

    occupied = _fetch_occupied_map(supabase, [c["id"] for c in candidates], body.reservation_date)
    table = _first_available(candidates, occupied, body.start_time, end_time)
    if not table:
        raise HTTPException(status_code=409, detail="No tables available for this time -- please choose another slot")

    inserted = (
        supabase.table("reservations")
        .insert(
            {
                "table_id": table["id"],
                "party_size": body.party_size,
                "reservation_date": body.reservation_date.isoformat(),
                "start_time": body.start_time.isoformat(),
                "end_time": end_time.isoformat(),
                "status": "pending",
                "customer_name": body.customer_name.strip(),
                "customer_phone": body.customer_phone.strip(),
                "customer_note": body.customer_note,
            }
        )
        .execute()
    )
    return inserted.data[0]


def _fetch_reservation_or_404(supabase, reservation_id: str) -> dict:
    result = supabase.table("reservations").select("*").eq("id", reservation_id).maybe_single().execute()
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Reservation not found")
    return result.data


@router.get("/public/reservations/{reservation_id}", response_model=ReservationStatusResponse)
def public_reservation_status(reservation_id: str):
    return _fetch_reservation_or_404(get_supabase(), reservation_id)


# ---------------------------------------------------------------------------
# Tables (staff-facing catalog)
# ---------------------------------------------------------------------------


@router.get("/tables", response_model=list[TableOut])
def list_tables(user: CurrentUser = Depends(get_current_user)):
    result = get_supabase().table("tables").select("*").order("label").execute()
    return result.data


@router.post("/tables", response_model=TableOut)
def create_table(body: TableCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    payload = body.model_dump(exclude_unset=True, exclude_none=True)
    label = (payload.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=422, detail="Table label is required")
    payload["label"] = label
    try:
        result = get_supabase().table("tables").insert(payload).execute()
    except APIError as e:
        # tables.label is UNIQUE (0025) -- a retried or duplicate create lands
        # here. Return a real 4xx (with CORS headers, via the middleware) so the
        # dashboard shows a readable toast instead of a masked "NetworkError".
        if e.code == "23505":
            raise HTTPException(status_code=409, detail=f'A table named "{label}" already exists')
        raise HTTPException(status_code=502, detail=f"Could not create table: {e.message}")
    if not result.data:
        raise HTTPException(status_code=502, detail="Table insert returned no row")
    return result.data[0]


@router.patch("/tables/{table_id}", response_model=TableOut)
def update_table(table_id: str, body: TableUpdate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    existing = supabase.table("tables").select("id").eq("id", table_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Table not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    # Touching any layout field via the floor-plan editor marks the table as
    # positioned/verified, and keeps `capacity` (the availability engine's
    # filter column) in step with the flexible max.
    if any(f in update_data for f in _LAYOUT_FIELDS):
        update_data["needs_layout_review"] = False
        if update_data.get("capacity_max") is not None:
            update_data["capacity"] = update_data["capacity_max"]
    result = supabase.table("tables").update(update_data).eq("id", table_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Table not found")
    return result.data[0]


# ---------------------------------------------------------------------------
# Staff-facing (authenticated) -- the review dashboard
# ---------------------------------------------------------------------------


@router.get("/reservations", response_model=list[ReservationOut])
def list_reservations(
    status_filter: str | None = Query(None, alias="status"),
    reservation_date: date | None = Query(None, alias="date"),
    limit: int = Query(200, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    query = get_supabase().table("reservations").select(
        "*, tables(label), reservation_overrides(reason, created_at, overridden_by)"
    )
    if status_filter:
        query = query.eq("status", status_filter)
    if reservation_date:
        query = query.eq("reservation_date", reservation_date.isoformat())
    result = query.order("reservation_date", desc=True).order("start_time", desc=True).limit(limit).execute()
    return [_to_reservation_out(row) for row in result.data]


def _fetch_reservation_with_table(supabase, reservation_id: str) -> dict:
    result = (
        supabase.table("reservations")
        .select("*, tables(label)")
        .eq("id", reservation_id)
        .maybe_single()
        .execute()
    )
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Reservation not found")
    return result.data


@router.post("/reservations/{reservation_id}/confirm", response_model=ReservationOut)
def confirm_reservation(reservation_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Reservation is already {reservation['status']}")

    updated = (
        supabase.table("reservations")
        .update(
            {
                "status": "confirmed",
                "confirmed_by": user.id,
                "confirmed_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .eq("id", reservation_id)
        .execute()
    )
    return _to_reservation_out({**updated.data[0], "tables": reservation.get("tables")})


@router.post("/reservations/{reservation_id}/decline", response_model=ReservationOut)
def decline_reservation(
    reservation_id: str,
    body: DeclineReservationRequest,
    user: CurrentUser = Depends(get_current_user),
):
    if not body.reason or not body.reason.strip():
        raise HTTPException(status_code=400, detail="A reason is required")

    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Reservation is already {reservation['status']}")

    updated = (
        supabase.table("reservations")
        .update(
            {
                "status": "declined",
                "declined_reason": body.reason.strip(),
                "declined_by": user.id,
                "declined_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .eq("id", reservation_id)
        .execute()
    )
    return _to_reservation_out({**updated.data[0], "tables": reservation.get("tables")})


# ---------------------------------------------------------------------------
# POS terminal integration -- is this table reservation-blocked right now?
# ---------------------------------------------------------------------------


@router.get("/pos/tables/status", response_model=PosTableStatusResponse)
def pos_table_status(
    table_number: int = Query(..., gt=0),
    at: Optional[datetime] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """Called by the POS when a cashier picks a table for a Dine In order.
    `at` defaults to now (PH). A table_number with no `pos_table_number`
    mapping is treated as unmanaged -> never blocked (same permissive
    posture the POS had before this feature)."""
    supabase = get_supabase()
    when = at.replace(tzinfo=None) if at is not None else _now_ph()

    table = _table_by_pos_number(supabase, table_number)
    if not table:
        return {"blocked": False, "pos_table_number": table_number}

    reservation = _blocking_reservation(supabase, table["id"], when)
    return {
        "blocked": reservation is not None,
        "pos_table_number": table_number,
        "table_id": table["id"],
        "table_label": table["label"],
        "reservation": reservation,
    }


@router.get("/pos/tables/overview", response_model=list[PosTableOverview])
def pos_tables_overview(user: CurrentUser = Depends(get_current_user)):
    """Every active, POS-mapped table plus its live state, for the POS
    Terminal's Dine In table picker. `occupied` = has an open dine-in
    transaction; `reserved` = a confirmed reservation is in its blocking
    window right now (same rule as GET /pos/tables/status, one call for the
    whole floor). The authoritative block/override check still happens per
    table at charge time -- this is a selection aid, not a gate."""
    supabase = get_supabase()
    tables = (
        supabase.table("tables")
        .select("id, label, capacity, capacity_min, capacity_max, pos_table_number")
        .eq("active", True)
        .not_.is_("pos_table_number", "null")
        .order("pos_table_number")
        .execute()
        .data
    )
    open_txn_tables = {
        r["table_number"]
        for r in supabase.table("transactions")
        .select("table_number")
        .eq("status", "open")
        .eq("order_type", "dine_in")
        .execute()
        .data
        if r.get("table_number") is not None
    }
    now = _now_ph()
    overview = []
    for t in tables:
        blocking = _blocking_reservation(supabase, t["id"], now)
        overview.append(
            {
                "pos_table_number": t["pos_table_number"],
                "label": t["label"],
                "capacity_min": t.get("capacity_min"),
                "capacity_max": t.get("capacity_max") or t["capacity"],
                "occupied": t["pos_table_number"] in open_txn_tables,
                "reserved": blocking is not None,
                "reservation": blocking,
            }
        )
    return overview


@router.post("/pos/tables/override", response_model=PosTableOverrideResponse)
def pos_table_override(body: PosTableOverrideRequest, user: CurrentUser = Depends(get_current_user)):
    """Manager-only: deliberately seat a walk-in on a reservation-blocked
    table. Mirrors the Owner's Request re-verification in transactions.py --
    the acting user re-enters their OWN kiosk credentials, and must be a
    manager/executive. Writes an audit row consumed once by the next sale."""
    require_role(user, "manager", "executive")

    profile = verify_employee_pin(body.employee_number, body.pin)
    if not profile or profile["id"] != user.id:
        raise HTTPException(status_code=403, detail="Employee number/PIN did not match your logged-in account")

    supabase = get_supabase()
    table = _table_by_pos_number(supabase, body.table_number)
    if not table:
        raise HTTPException(status_code=404, detail="No reservation table is mapped to that POS number")

    reservation = _blocking_reservation(supabase, table["id"], _now_ph())
    if reservation is None:
        raise HTTPException(status_code=404, detail="That table is not currently reservation-blocked")

    inserted = (
        supabase.table("reservation_overrides")
        .insert(
            {
                "reservation_id": reservation["id"],
                "table_id": table["id"],
                "pos_table_number": body.table_number,
                "overridden_by": user.id,
                "reason": body.reason.strip(),
            }
        )
        .execute()
    )
    return {"override_id": inserted.data[0]["id"]}


@router.post("/reservations/{reservation_id}/cancel", response_model=ReservationOut)
def cancel_reservation(reservation_id: str, user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] != "confirmed":
        raise HTTPException(status_code=400, detail=f"Only a confirmed reservation can be cancelled (currently {reservation['status']})")

    updated = (
        supabase.table("reservations")
        .update(
            {
                "status": "cancelled",
                "cancelled_by": user.id,
                "cancelled_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .eq("id", reservation_id)
        .execute()
    )
    return _to_reservation_out({**updated.data[0], "tables": reservation.get("tables")})
