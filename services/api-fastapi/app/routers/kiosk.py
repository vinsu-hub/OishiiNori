"""Staff Clock kiosk endpoints.

The kiosk (apps/staff-clock) is a shared walk-up device with no logged-in
Supabase session, so it can't use get_current_user like the dashboard.
Every mutating call here re-derives the employee from employee_number+PIN
(verify) or an attendance_log_id already returned by a prior verify/clock-in
in the same kiosk visit, and writes via the service-role client. The PIN is
never returned to any client -- only bcrypt-compared server-side. No branch
concept exists in this build (locked scope), unlike the SMFC reference.
"""

import bcrypt
from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from postgrest.exceptions import APIError

from app.attendance_utils import auto_close_stale_attendance, compute_attendance_breakdown, hr_table
from app.auth import _profile_active_supported_check
from app.deps import get_supabase
from app.rate_limit import client_ip, enforce_rate_limit
from app.schemas import (
    AttendanceLogResponse,
    KioskClockInRequest,
    KioskClockOutRequest,
    KioskVerifyRequest,
    KioskVerifyResponse,
)

router = APIRouter(tags=["kiosk"])

_INVALID_CREDENTIALS = HTTPException(status_code=401, detail="Employee number or PIN is incorrect")


def _get_open_attendance(employee_id: str) -> dict | None:
    result = (
        hr_table("attendance_logs")
        .select("*")
        .eq("employee_id", employee_id)
        .eq("date", date.today().isoformat())
        .eq("status", "working")
        .maybe_single()
        .execute()
    )
    return result.data if result and result.data else None


def _get_completed_today(employee_id: str) -> dict | None:
    result = (
        hr_table("attendance_logs")
        .select("id")
        .eq("employee_id", employee_id)
        .eq("date", date.today().isoformat())
        .eq("status", "completed")
        .maybe_single()
        .execute()
    )
    return result.data if result and result.data else None


@router.post("/kiosk/verify", response_model=KioskVerifyResponse)
def kiosk_verify(body: KioskVerifyRequest, request: Request):
    supabase = get_supabase()
    # A scripted client could otherwise guess PINs against a known employee
    # number with no throttling at all -- the concrete "swarm of queries"
    # risk actually found in this codebase. Keyed by employee_number+ip (not
    # ip alone) so slowing down an attack on one account doesn't also lock
    # out everyone else legitimately using the same shared kiosk device.
    enforce_rate_limit(
        supabase, f"kiosk-verify:{body.employee_number}:{client_ip(request)}", window_seconds=60, limit=10
    )
    active_supported = _profile_active_supported_check(supabase)
    columns = "id, full_name, position, department, photo_url, kiosk_pin_hash" + (
        ", active" if active_supported else ""
    )
    result = (
        supabase.table("profiles")
        .select(columns)
        .eq("employee_number", body.employee_number)
        .maybe_single()
        .execute()
    )
    if not result or not result.data or not result.data.get("kiosk_pin_hash"):
        raise _INVALID_CREDENTIALS
    profile = result.data
    if active_supported and profile.get("active") is False:
        raise _INVALID_CREDENTIALS
    if not bcrypt.checkpw(body.pin.encode("utf-8"), profile["kiosk_pin_hash"].encode("utf-8")):
        raise _INVALID_CREDENTIALS

    # Kiosk devices are lazily upserted the first time a client-generated
    # kiosk_id is seen, not manually provisioned (0010's migration comment).
    hr_table("kiosks").upsert({"id": body.kiosk_id}, on_conflict="id").execute()

    auto_close_stale_attendance()

    open_row = _get_open_attendance(profile["id"])
    if open_row:
        today_status = "working"
        attendance_log_id = open_row["id"]
    elif _get_completed_today(profile["id"]):
        today_status = "completed"
        attendance_log_id = None
    else:
        today_status = "not_started"
        attendance_log_id = None

    return {
        "id": profile["id"],
        "full_name": profile["full_name"],
        "photo_url": profile.get("photo_url"),
        "position": profile.get("position"),
        "department": profile.get("department"),
        "today_status": today_status,
        "attendance_log_id": attendance_log_id,
        # The kiosk UI's Active Work screen (elapsed timer, End Today's Work)
        # needs the actual clock_in time and log id, not just the id string --
        # already fetched above via _get_open_attendance, no extra query.
        "log": open_row,
    }


@router.post("/kiosk/clock-in", response_model=AttendanceLogResponse)
def kiosk_clock_in(body: KioskClockInRequest):
    profile_result = (
        get_supabase().table("profiles").select("id").eq("id", body.employee_id).maybe_single().execute()
    )
    if not profile_result or not profile_result.data:
        raise HTTPException(status_code=404, detail="Employee not found")

    # Double-tap safety: an already-open shift is returned as a no-op.
    existing_open = _get_open_attendance(body.employee_id)
    if existing_open:
        return existing_open

    if _get_completed_today(body.employee_id):
        raise HTTPException(status_code=409, detail="Already completed a shift today")

    clock_in_time = datetime.now(timezone.utc)
    try:
        insert_result = (
            hr_table("attendance_logs")
            .insert(
                {
                    "employee_id": body.employee_id,
                    "kiosk_id": body.kiosk_id,
                    "clock_in": clock_in_time.isoformat(),
                    "date": date.today().isoformat(),
                    "status": "working",
                }
            )
            .execute()
        )
    except APIError as e:
        if e.code == "23505":
            # Lost a race against a concurrent clock-in for the same
            # employee -- attendance_logs_one_open_shift_per_day caught it.
            existing = _get_open_attendance(body.employee_id)
            if existing:
                return existing
        raise
    return insert_result.data[0]


@router.post("/kiosk/clock-out", response_model=AttendanceLogResponse)
def kiosk_clock_out(body: KioskClockOutRequest):
    log_result = (
        hr_table("attendance_logs").select("*").eq("id", body.attendance_log_id).maybe_single().execute()
    )
    if not log_result or not log_result.data:
        raise HTTPException(status_code=404, detail="Attendance record not found")
    row = log_result.data
    if row["status"] != "working":
        raise HTTPException(status_code=400, detail=f"Cannot clock out from status '{row['status']}'")

    clock_in_time = datetime.fromisoformat(row["clock_in"].replace("Z", "+00:00"))
    if clock_in_time.tzinfo is None:
        clock_in_time = clock_in_time.replace(tzinfo=timezone.utc)
    clock_out_time = datetime.now(timezone.utc)

    breakdown = compute_attendance_breakdown(clock_in_time, clock_out_time, row.get("is_rest_day", False))

    update_result = (
        hr_table("attendance_logs")
        .update({"clock_out": clock_out_time.isoformat(), "status": "completed", **breakdown})
        .eq("id", row["id"])
        .execute()
    )
    return update_result.data[0]
