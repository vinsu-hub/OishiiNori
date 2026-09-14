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

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role, verify_employee_pin
from app.deps import get_supabase
from app.idempotency import check_idempotency_key, record_idempotency_key
from app.ph_time import PH_UTC_OFFSET
from app.rate_limit import client_ip, enforce_rate_limit
from app.schemas import (
    _LAYOUT_FIELDS,
    CreateReservationRequest,
    DeclineReservationRequest,
    PlaceReservationRequest,
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

# How far ahead of a placed reservation's start_time the fire-advance-orders
# job (Vercel Cron, see vercel.json) converts its staged advance order into
# a real transaction and sends it to Kitchen Display -- long enough that
# prep is done by the time the guest actually arrives.
ADVANCE_ORDER_LEAD_MINUTES = 20

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


def _fetch_all_active_tables(supabase) -> list[dict]:
    """Every active table, smallest-capacity-first -- the full pool a slot's
    bin-packing feasibility check draws from. A reservation no longer
    commits to one of these at booking time (0045); it only needs to know
    packing is possible."""
    return (
        supabase.table("tables")
        .select("id, label, capacity")
        .eq("active", True)
        .order("capacity")
        .execute()
        .data
    )


def _fetch_reservations_for_date(supabase, reservation_date: date) -> list[dict]:
    """Every holding (pending/confirmed) reservation on this date, placed or
    not -- one query, reused across every slot in the availability listing
    and the booking-acceptance check. Only declined/cancelled are excluded."""
    return (
        supabase.table("reservations")
        .select("table_id, party_size, start_time, end_time")
        .eq("reservation_date", reservation_date.isoformat())
        .in_("status", _HOLDING_STATUSES)
        .execute()
        .data
    )


def _bin_pack_feasible(tables: list[dict], party_sizes: list[int]) -> bool:
    """Best-fit-decreasing bin packing: can every party in `party_sizes`
    (already includes the new candidate) be seated at its own table from
    `tables`, each big enough for that party? A single-location restaurant
    with ~12 tables and a handful of reservations per slot makes greedy
    packing exact enough in practice -- no need for a real ILP solver."""
    remaining = sorted(tables, key=lambda t: t["capacity"])
    for size in sorted(party_sizes, reverse=True):
        fit_idx = next((i for i, t in enumerate(remaining) if t["capacity"] >= size), None)
        if fit_idx is None:
            return False
        remaining.pop(fit_idx)
    return True


def _slot_feasible(
    all_tables: list[dict],
    reservations_for_date: list[dict],
    new_party_size: int,
    start: time,
    end: time,
) -> bool:
    """Feasibility for one [start, end) slot window, replacing the old "find
    one free table and commit it" model: a *placed* reservation overlapping
    the window removes its specific table from the pool; an *unplaced*
    holding reservation overlapping the window consumes capacity (not a
    specific table) alongside the new candidate party -- this is what makes
    booking no longer lock a table (0045)."""
    placed_table_ids = {
        r["table_id"]
        for r in reservations_for_date
        if r["table_id"] and _overlaps(start, end, time.fromisoformat(r["start_time"]), time.fromisoformat(r["end_time"]))
    }
    pool = [t for t in all_tables if t["id"] not in placed_table_ids]
    unplaced_sizes = [
        r["party_size"]
        for r in reservations_for_date
        if not r["table_id"] and _overlaps(start, end, time.fromisoformat(r["start_time"]), time.fromisoformat(r["end_time"]))
    ]
    return _bin_pack_feasible(pool, unplaced_sizes + [new_party_size])


def _to_reservation_out(row: dict, advance_order_items: Optional[list[dict]] = None) -> dict:
    table = row.pop("tables", None) or {}
    row["table_label"] = table.get("label")
    row["pos_table_number"] = table.get("pos_table_number")
    row["overrides"] = row.pop("reservation_overrides", None) or []
    row["advance_order_items"] = advance_order_items or []
    return row


def _fetch_advance_order_items(supabase, reservation_ids: list[str]) -> dict[str, list[dict]]:
    """Staged advance-order items for a batch of reservations, denormalized
    with product/add-on names the same way digital_menu.py's list endpoint
    does for digital_order_items/digital_order_addons."""
    if not reservation_ids:
        return {}
    rows = (
        supabase.table("reservation_items")
        .select(
            "*, product_sizes(products(name)), "
            "reservation_item_addons(addon_id, quantity, menu_addons(name))"
        )
        .in_("reservation_id", reservation_ids)
        .execute()
        .data
    )
    by_reservation: dict[str, list[dict]] = {}
    for row in rows:
        reservation_id = row.pop("reservation_id")
        product = (row.pop("product_sizes", None) or {}).get("products") or {}
        row["product_name"] = product.get("name")
        addons = []
        for a in row.pop("reservation_item_addons", None) or []:
            addon_info = a.pop("menu_addons", None) or {}
            a["addon_name"] = addon_info.get("name")
            addons.append(a)
        row["addons"] = addons
        by_reservation.setdefault(reservation_id, []).append(row)
    return by_reservation


def _insert_reservation_items(supabase, reservation_id: str, items) -> None:
    """Validates and stages an advance order's items against the live
    catalog (same posture as digital_menu.py's submit_digital_order --
    never trust a client-sent price/availability), without charging or
    deducting anything yet. Converted into a real transaction later by the
    fire-advance-orders job."""
    size_ids = [i.product_size_id for i in items]
    sizes_result = (
        supabase.table("product_sizes").select("id, products(active)").in_("id", size_ids).execute()
    )
    sizes_by_id = {s["id"]: s for s in sizes_result.data}
    missing = [sid for sid in size_ids if sid not in sizes_by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"Product sizes not found: {missing}")
    inactive = [sid for sid in size_ids if not (sizes_by_id[sid].get("products") or {}).get("active", True)]
    if inactive:
        raise HTTPException(status_code=400, detail=f"Items no longer available: {inactive}")

    addon_ids = [a.addon_id for i in items for a in i.addons]
    addons_by_id: dict[str, dict] = {}
    if addon_ids:
        addons_result = supabase.table("menu_addons").select("id, active").in_("id", addon_ids).execute()
        addons_by_id = {a["id"]: a for a in addons_result.data}
        missing_addons = [aid for aid in addon_ids if aid not in addons_by_id]
        if missing_addons:
            raise HTTPException(status_code=404, detail=f"Add-ons not found: {missing_addons}")
        inactive_addons = [aid for aid in addon_ids if not addons_by_id[aid]["active"]]
        if inactive_addons:
            raise HTTPException(status_code=400, detail=f"Add-ons no longer available: {inactive_addons}")

    for item in items:
        inserted_item = (
            supabase.table("reservation_items")
            .insert(
                {
                    "reservation_id": reservation_id,
                    "product_size_id": item.product_size_id,
                    "quantity": item.quantity,
                    "held_ingredients": item.held_ingredients,
                    "notes": item.notes,
                }
            )
            .execute()
            .data[0]
        )
        if item.addons:
            supabase.table("reservation_item_addons").insert(
                [
                    {
                        "reservation_item_id": inserted_item["id"],
                        "addon_id": addon.addon_id,
                        "quantity": addon.quantity,
                    }
                    for addon in item.addons
                ]
            ).execute()


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
def public_availability(
    request: Request,
    reservation_date: date = Query(..., alias="date"),
    party_size: int = Query(..., gt=0),
):
    supabase = get_supabase()
    # Looser than submission -- the reservation form calls this on every
    # date/party-size change, which is legitimate normal use, not abuse.
    enforce_rate_limit(supabase, f"reservation-availability:{client_ip(request)}", window_seconds=60, limit=60)
    open_time, close_time, closed_weekdays = _get_business_hours(supabase)

    if reservation_date.weekday() in closed_weekdays:
        return {"date": reservation_date, "party_size": party_size, "closed": True, "slots": []}

    all_tables = _fetch_all_active_tables(supabase)
    reservations_for_date = _fetch_reservations_for_date(supabase, reservation_date)

    slots: list[dict] = []
    t = open_time
    while _time_add_minutes(t, RESERVATION_DURATION_MINUTES) <= close_time:
        end = _time_add_minutes(t, RESERVATION_DURATION_MINUTES)
        available = bool(all_tables) and _slot_feasible(all_tables, reservations_for_date, party_size, t, end)
        slots.append({"time": t.strftime("%H:%M"), "available": available})
        t = _time_add_minutes(t, SLOT_GRANULARITY_MINUTES)

    return {"date": reservation_date, "party_size": party_size, "closed": False, "slots": slots}


@router.post("/public/reservations", response_model=ReservationStatusResponse)
def submit_reservation(body: CreateReservationRequest, request: Request):
    supabase = get_supabase()
    enforce_rate_limit(supabase, f"reservation-submit:{client_ip(request)}", window_seconds=60, limit=20)
    existing_id = check_idempotency_key(supabase, body.idempotency_key, "POST /public/reservations")
    if existing_id:
        return _fetch_reservation_or_404(supabase, existing_id)

    open_time, close_time, closed_weekdays = _get_business_hours(supabase)

    if body.reservation_date.weekday() in closed_weekdays:
        raise HTTPException(status_code=400, detail="We're closed on this day")

    end_time = _time_add_minutes(body.start_time, RESERVATION_DURATION_MINUTES)
    if body.start_time < open_time or end_time > close_time:
        raise HTTPException(status_code=400, detail="Outside business hours for this reservation length")

    all_tables = _fetch_all_active_tables(supabase)
    if not all_tables or body.party_size > max(t["capacity"] for t in all_tables):
        raise HTTPException(status_code=400, detail="No table can seat this party size")

    # The capacity-pool feasibility check + insert happen together in one
    # atomic Postgres function (migration 0050) under an advisory lock
    # scoped to this date -- a plain read-then-insert here would leave the
    # same TOCTOU window place_reservation used to have before its own
    # DB-level fix (migration 0047): two near-simultaneous bookings for the
    # last remaining slot could otherwise both pass a Python-side check
    # before either commits.
    has_advance_order = bool(body.advance_order_items)
    try:
        result = supabase.rpc(
            "submit_reservation_atomic",
            {
                "p_party_size": body.party_size,
                "p_reservation_date": body.reservation_date.isoformat(),
                "p_start_time": body.start_time.isoformat(),
                "p_end_time": end_time.isoformat(),
                "p_customer_name": body.customer_name.strip(),
                "p_customer_phone": body.customer_phone.strip(),
                "p_customer_note": body.customer_note,
                "p_has_advance_order": has_advance_order,
            },
        ).execute()
    except APIError as e:
        if "NO_CAPACITY" in (e.message or ""):
            raise HTTPException(
                status_code=409, detail="No tables available for this time -- please choose another slot"
            )
        raise HTTPException(status_code=502, detail=f"Could not submit the reservation: {e.message}")

    reservation = result.data
    if has_advance_order:
        _insert_reservation_items(supabase, reservation["id"], body.advance_order_items)
    record_idempotency_key(supabase, body.idempotency_key, "POST /public/reservations", reservation["id"])
    return reservation


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
        "*, tables(label, pos_table_number), reservation_overrides(reason, created_at, overridden_by)"
    )
    if status_filter:
        query = query.eq("status", status_filter)
    if reservation_date:
        query = query.eq("reservation_date", reservation_date.isoformat())
    result = query.order("reservation_date", desc=True).order("start_time", desc=True).limit(limit).execute()
    rows = result.data
    items_by_reservation = _fetch_advance_order_items(get_supabase(), [r["id"] for r in rows if r.get("has_advance_order")])
    return [_to_reservation_out(row, items_by_reservation.get(row["id"])) for row in rows]


def _fetch_reservation_with_table(supabase, reservation_id: str) -> dict:
    result = (
        supabase.table("reservations")
        .select("*, tables(label, pos_table_number)")
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


@router.post("/reservations/{reservation_id}/seat", response_model=ReservationOut)
def seat_reservation(reservation_id: str, user: CurrentUser = Depends(get_current_user)):
    """Mark a confirmed reservation as seated without (yet) ringing up an
    order -- the Floor Plan's manual "Mark seated" action, for parties seated
    outside the POS "Seat this reservation" flow that would otherwise link a
    transaction. Idempotent: re-seating keeps the original seated_at."""
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] != "confirmed":
        raise HTTPException(status_code=400, detail=f"Only a confirmed reservation can be seated (currently {reservation['status']})")

    if reservation.get("seated_at"):
        return _to_reservation_out(reservation)

    updated = (
        supabase.table("reservations")
        .update({"seated_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", reservation_id)
        .execute()
    )
    return _to_reservation_out({**updated.data[0], "tables": reservation.get("tables")})


@router.post("/reservations/{reservation_id}/unseat", response_model=ReservationOut)
def unseat_reservation(reservation_id: str, user: CurrentUser = Depends(get_current_user)):
    """Undo a mis-tapped seating. Refused while a live (non-voided) linked
    transaction exists -- clear the order first."""
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)

    txn_id = reservation.get("transaction_id")
    if txn_id:
        txn = supabase.table("transactions").select("status").eq("id", txn_id).maybe_single().execute()
        if txn and txn.data and txn.data["status"] != "voided":
            raise HTTPException(status_code=400, detail="This reservation has an active order -- void or close it first")

    updated = (
        supabase.table("reservations")
        .update({"seated_at": None, "transaction_id": None})
        .eq("id", reservation_id)
        .execute()
    )
    return _to_reservation_out({**updated.data[0], "tables": reservation.get("tables")})


@router.post("/reservations/{reservation_id}/place", response_model=ReservationOut)
def place_reservation(
    reservation_id: str,
    body: PlaceReservationRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """The cashier's explicit "Place Reservation" action -- pins a confirmed,
    still-unplaced ticket onto a real table. This is the decision point that
    replaced auto-seating: it does not open a POS order, it just marks the
    table "waiting for customer" on the Floor Plan. table_id/placed_at/
    placed_by are what _blocking_reservation and the availability engine key
    off from this point on."""
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] != "confirmed":
        raise HTTPException(
            status_code=400,
            detail=f"Only a confirmed reservation can be placed (currently {reservation['status']})",
        )
    if reservation.get("table_id"):
        raise HTTPException(status_code=400, detail="Reservation is already placed on a table")

    table_result = (
        supabase.table("tables")
        .select("id, label, capacity, capacity_min, capacity_max, active, pos_table_number")
        .eq("id", body.table_id)
        .maybe_single()
        .execute()
    )
    table = table_result.data if table_result and table_result.data else None
    if not table or not table["active"]:
        raise HTTPException(status_code=404, detail="Table not found")

    cap_max = table.get("capacity_max") or table["capacity"]
    if reservation["party_size"] > cap_max:
        raise HTTPException(
            status_code=400,
            detail=f"Party of {reservation['party_size']} exceeds table {table['label']}'s capacity of {cap_max}",
        )

    # _blocking_reservation only answers "right now" -- placement can happen
    # well ahead of the reservation's own window, so check directly against
    # any other holding reservation already placed on this table whose
    # window overlaps this one's.
    r_start = time.fromisoformat(reservation["start_time"])
    r_end = time.fromisoformat(reservation["end_time"])
    others = (
        supabase.table("reservations")
        .select("id, start_time, end_time")
        .eq("table_id", body.table_id)
        .eq("reservation_date", reservation["reservation_date"])
        .in_("status", _HOLDING_STATUSES)
        .neq("id", reservation_id)
        .execute()
        .data
    )
    for o in others:
        if _overlaps(r_start, r_end, time.fromisoformat(o["start_time"]), time.fromisoformat(o["end_time"])):
            raise HTTPException(
                status_code=409,
                detail=f"Table {table['label']} is already placed for another reservation in this window",
            )

    try:
        updated = (
            supabase.table("reservations")
            .update(
                {
                    "table_id": body.table_id,
                    "placed_at": datetime.now(timezone.utc).isoformat(),
                    "placed_by": user.id,
                }
            )
            .eq("id", reservation_id)
            .execute()
        )
    except APIError as e:
        # reservations_no_table_overlap (migration 0047) -- the hard DB-level
        # backstop for the exact TOCTOU window the check above closes for the
        # common case: two concurrent placements can both pass the Python
        # overlap check before either commits. Surface the same 409 either
        # way so the API contract doesn't change.
        if e.code == "23P01":
            raise HTTPException(
                status_code=409,
                detail=f"Table {table['label']} is already placed for another reservation in this window",
            )
        raise HTTPException(status_code=502, detail=f"Could not place the reservation: {e.message}")
    return _to_reservation_out({**updated.data[0], "tables": table})


@router.post("/reservations/{reservation_id}/arrive", response_model=ReservationOut)
def arrive_reservation(reservation_id: str, user: CurrentUser = Depends(get_current_user)):
    """The cashier's "Guest has arrived" action -- a pure status stamp,
    deliberately separate from creating or touching any transaction. If an
    advance order already fired to the kitchen (fire-advance-orders ran
    ahead of this), that transaction was created earlier; if not, the
    Floor Plan falls back to the normal "Place Order Now" POS deep-link.
    Idempotent."""
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] != "confirmed":
        raise HTTPException(
            status_code=400,
            detail=f"Only a confirmed reservation can be marked arrived (currently {reservation['status']})",
        )
    if not reservation.get("table_id"):
        raise HTTPException(status_code=400, detail="Reservation must be placed on a table first")

    if reservation.get("arrived_at"):
        return _to_reservation_out(reservation)

    updated = (
        supabase.table("reservations")
        .update({"arrived_at": datetime.now(timezone.utc).isoformat()})
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
    """Void/cancel a ticket -- callable from the Floor Plan popup at any
    stage before the guest arrives (unplaced, or placed and waiting), not
    just from the Requests tab. Once arrived_at is stamped there may already
    be a real order in flight; cancel the order itself instead."""
    supabase = get_supabase()
    reservation = _fetch_reservation_with_table(supabase, reservation_id)
    if reservation["status"] not in ("pending", "confirmed"):
        raise HTTPException(status_code=400, detail=f"Reservation is already {reservation['status']}")
    if reservation.get("arrived_at"):
        raise HTTPException(status_code=400, detail="Guest has already arrived -- cancel the order instead")

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


# ---------------------------------------------------------------------------
# Advance-order firing
# ---------------------------------------------------------------------------
# Originally a Vercel Cron target, but the project's Hobby plan only allows
# daily cron schedules -- far too coarse for "fire ~20 minutes before this
# specific reservation's start_time" -- and a cron job at that frequency
# fails the whole deploy outright ("Hobby accounts are limited to daily cron
# jobs"). So this follows the system's existing locked decision (polling
# throughout, no websockets/scheduled-job infra) instead: it's a normal
# authenticated staff endpoint, polled by the Floor Plan on the same
# interval it already polls tables/transactions/reservations on. Any signed-
# in staff role may call it -- it only converts a reservation's own
# already-staged advance order, nothing sensitive.


@router.get("/reservations/fire-advance-orders")
def fire_advance_orders(user: CurrentUser = Depends(get_current_user)):
    """Converts today's placed reservations' staged advance orders into real
    transactions once within ADVANCE_ORDER_LEAD_MINUTES of start_time, so
    the kitchen has time to prep before the guest actually arrives (the
    Floor Plan's "Guest has arrived" action never creates an order itself --
    see arrive_reservation above). Goes through the exact same
    _create_transaction_row path every other sale uses. Deferred import
    avoids a circular import: transactions.py imports from this module."""
    from app.routers.transactions import _create_transaction_row
    from app.schemas import TransactionItemAddonCreate, TransactionItemCreate

    supabase = get_supabase()
    now = _now_ph()
    threshold = _time_add_minutes(now.time(), ADVANCE_ORDER_LEAD_MINUTES)

    candidates = (
        supabase.table("reservations")
        .select("id, party_size, start_time, table_id, placed_by, tables(pos_table_number, label, active)")
        .eq("reservation_date", now.date().isoformat())
        .eq("status", "confirmed")
        .eq("has_advance_order", True)
        .is_("advance_order_fired_at", "null")
        .is_("arrived_at", "null")
        .not_.is_("table_id", "null")
        .execute()
        .data
    )

    fired: list[str] = []
    skipped: list[dict] = []
    for r in candidates:
        if threshold < time.fromisoformat(r["start_time"]):
            continue  # not within the lead window yet

        table = r.get("tables") or {}
        pos_table_number = table.get("pos_table_number")
        if not pos_table_number or not r.get("placed_by"):
            # Table since unmapped, or placed_by missing (shouldn't happen --
            # placement always stamps both together) -- skip this one rather
            # than fail the whole batch; it'll be retried next tick.
            skipped.append({"id": r["id"], "reason": "table unmapped or placed_by missing"})
            continue
        if table.get("active") is False:
            # A manager deactivated this table after it was placed --
            # _create_transaction_row has no reason to reject a bare
            # table_number, so without this check it would silently fire a
            # dine-in order against a table that no longer exists on the
            # floor plan.
            skipped.append({"id": r["id"], "reason": "table deactivated since booking"})
            continue

        # Everything past this point can genuinely fail for one reservation
        # (a product deactivated since booking, the placing employee's
        # account since removed, a transient DB error, ...) without that
        # being anyone else's problem. This poll-driven endpoint has no
        # per-reservation isolation otherwise -- an uncaught exception here
        # would abort the whole call and silently block every *other* due
        # reservation's advance order from firing too, for as long as staff
        # keep the Floor Plan open. Isolate it: log and skip, don't propagate.
        try:
            item_rows = (
                supabase.table("reservation_items")
                .select("*, reservation_item_addons(addon_id, quantity)")
                .eq("reservation_id", r["id"])
                .execute()
                .data
            )
            if not item_rows:
                skipped.append({"id": r["id"], "reason": "no staged items"})
                continue

            # _create_transaction_row never checks products.active (unlike
            # menu_addons, which it does check) -- without re-validating
            # here, a product deactivated between booking and firing would
            # silently still get charged instead of failing cleanly.
            size_ids = [i["product_size_id"] for i in item_rows]
            sizes_result = (
                supabase.table("product_sizes")
                .select("id, products(active)")
                .in_("id", size_ids)
                .execute()
                .data
            )
            inactive = [
                s["id"] for s in sizes_result if not (s.get("products") or {}).get("active", True)
            ]
            if inactive:
                skipped.append({"id": r["id"], "reason": f"item no longer available: {inactive}"})
                continue

            items = [
                TransactionItemCreate(
                    product_size_id=i["product_size_id"],
                    quantity=i["quantity"],
                    held_ingredients=i.get("held_ingredients") or [],
                    addons=[
                        TransactionItemAddonCreate(addon_id=a["addon_id"], quantity=a["quantity"])
                        for a in (i.get("reservation_item_addons") or [])
                    ],
                )
                for i in item_rows
            ]

            transaction = _create_transaction_row(
                supabase,
                employee_id=r["placed_by"],
                items=items,
                order_type="dine_in",
                table_number=pos_table_number,
                guest_count=r["party_size"],
            )

            supabase.table("reservations").update(
                {
                    "advance_order_fired_at": datetime.now(timezone.utc).isoformat(),
                    "transaction_id": transaction.id,
                }
            ).eq("id", r["id"]).execute()
            fired.append(r["id"])
        except Exception as e:  # noqa: BLE001 -- isolate one bad reservation, never the whole batch
            skipped.append({"id": r["id"], "reason": str(e)[:200]})

    return {"fired": fired, "skipped": skipped, "checked": len(candidates)}
