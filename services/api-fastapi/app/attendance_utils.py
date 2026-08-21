"""Shared helpers for the hr-schema attendance/payroll tables.

Structurally ports the SMFC reference's attendance_utils.py DOLE-style
regular/OT/night-diff engine, adapted for this build's schema:
  - no branches, so no branch_id anywhere and no per-branch holiday scoping
  - no hr.attendance_breaks table here (0010's migration comment: not
    requested, nothing depends on it), so hours_worked is simply
    clock_out - clock_in with no break subtraction
  - hr.attendance_logs.status is a plain working/completed toggle (no
    on_break state), so there is nothing to skip because of a break
"""

from datetime import datetime, timedelta, timezone

from app.deps import get_supabase

AUTO_CLOSE_STALE_AFTER = timedelta(hours=16)
AUTO_CLOSE_SHIFT_CAP = timedelta(hours=12)

NIGHT_DIFF_START_HOUR = 22  # 10pm
NIGHT_DIFF_END_HOUR = 6  # 6am
REGULAR_HOURS_THRESHOLD = 8.0

PH_UTC_OFFSET = timedelta(hours=8)


def hr_table(name: str):
    return get_supabase().schema("hr").table(name)


def _parse_ts(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def compute_hours_worked(clock_in_time: datetime, clock_out_time: datetime) -> float:
    """(clock_out - clock_in) in hours. No break tracking exists in this
    schema, unlike the SMFC reference, so nothing is subtracted."""
    total_seconds = (clock_out_time - clock_in_time).total_seconds()
    return round(max(total_seconds, 0) / 3600, 4)


def split_regular_and_overtime(hours: float) -> tuple[float, float]:
    """First 8 worked hours are regular; anything beyond is overtime."""
    regular = min(hours, REGULAR_HOURS_THRESHOLD)
    overtime = max(hours - REGULAR_HOURS_THRESHOLD, 0.0)
    return round(regular, 4), round(overtime, 4)


def _night_window_overlap_hours(start: datetime, end: datetime) -> float:
    """Hours of [start, end) that fall within 22:00-06:00 Philippine local
    time. Timestamps are stored/compared as true UTC everywhere else in this
    codebase; night-differential hours are legally defined against local
    clock time, so this is the one place that shifts to PH local time before
    comparing against the window. Handles shifts crossing midnight by
    scanning each day boundary the shift touches."""
    if end <= start:
        return 0.0
    local_start = start + PH_UTC_OFFSET
    local_end = end + PH_UTC_OFFSET

    overlap_seconds = 0.0
    cursor = local_start.replace(hour=0, minute=0, second=0, microsecond=0)
    while cursor <= local_end:
        window_start = cursor.replace(hour=NIGHT_DIFF_START_HOUR, minute=0, second=0, microsecond=0)
        window_end = window_start + timedelta(hours=(24 - NIGHT_DIFF_START_HOUR) + NIGHT_DIFF_END_HOUR)
        overlap_start = max(local_start, window_start)
        overlap_end = min(local_end, window_end)
        if overlap_end > overlap_start:
            overlap_seconds += (overlap_end - overlap_start).total_seconds()
        cursor += timedelta(days=1)
    return overlap_seconds / 3600


def compute_night_diff_hours(clock_in_time: datetime, clock_out_time: datetime) -> float:
    """Overlap of the worked interval with 22:00-06:00 Philippine local time,
    in hours."""
    total = _night_window_overlap_hours(clock_in_time, clock_out_time)
    return round(max(total, 0.0), 4)


def resolve_day_scenario(log_date, is_rest_day: bool) -> tuple[str, str | None]:
    """Looks up hr.holidays for log_date, then combines with is_rest_day to
    pick the compound scenario key stored in hr.pay_multiplier_rules.
    Single-tenant: no branch_scope to disambiguate, unlike SMFC."""
    holiday_result = (
        hr_table("holidays")
        .select("id, holiday_type")
        .eq("holiday_date", log_date.isoformat() if hasattr(log_date, "isoformat") else log_date)
        .maybe_single()
        .execute()
    )
    holiday_row = holiday_result.data if holiday_result else None

    if not holiday_row:
        return ("rest_day" if is_rest_day else "regular_day"), None
    return scenario_key_for_holiday_type(holiday_row["holiday_type"], is_rest_day), holiday_row["id"]


def scenario_key_for_holiday_type(holiday_type: str, is_rest_day: bool) -> str:
    """Pure mapping from a hr.holidays.holiday_type + rest-day flag to the
    hr.pay_multiplier_rules.scenario_key it resolves to. Split out from
    resolve_day_scenario so it's unit-testable without a holidays lookup."""
    if holiday_type == "regular_holiday":
        return "regular_holiday_rest_day" if is_rest_day else "regular_holiday"
    if holiday_type == "special_non_working":
        return "special_non_working_rest_day" if is_rest_day else "special_non_working"
    return "special_working"


def compute_attendance_breakdown(clock_in_time: datetime, clock_out_time: datetime, is_rest_day: bool) -> dict:
    """Single entry point called from clock-out. Reuses compute_hours_worked()
    for gross hours, then layers scenario + OT + night-diff on top."""
    hours_worked = compute_hours_worked(clock_in_time, clock_out_time)
    regular_hours, overtime_hours = split_regular_and_overtime(hours_worked)
    night_diff_hours = compute_night_diff_hours(clock_in_time, clock_out_time)
    day_scenario, holiday_id = resolve_day_scenario(clock_in_time.date(), is_rest_day)
    return {
        "hours_worked": hours_worked,
        "regular_hours": regular_hours,
        "overtime_hours": overtime_hours,
        "night_diff_hours": night_diff_hours,
        "day_scenario": day_scenario,
        "holiday_id": holiday_id,
    }


def _force_close(row: dict) -> None:
    clock_in_time = _parse_ts(row["clock_in"])
    clock_out_time = clock_in_time + AUTO_CLOSE_SHIFT_CAP
    breakdown = compute_attendance_breakdown(clock_in_time, clock_out_time, row.get("is_rest_day", False))

    hr_table("attendance_logs").update(
        {
            "clock_out": clock_out_time.isoformat(),
            "status": "completed",
            "auto_closed": True,
            **breakdown,
        }
    ).eq("id", row["id"]).execute()


def auto_close_stale_attendance() -> None:
    """Force-close any shift left open past a safety cutoff, flagged
    auto_closed so a manager reviews it before it's trusted in a payroll
    run. Single-tenant: sweeps every open shift, not scoped to a branch.

    Called at every read/write path that could otherwise treat a stuck-open
    shift as contributing 0 hours (payroll) or block a legitimate next
    clock-in.
    """
    cutoff = (datetime.now(timezone.utc) - AUTO_CLOSE_STALE_AFTER).isoformat()
    stale = (
        hr_table("attendance_logs")
        .select("*")
        .eq("status", "working")
        .lt("clock_in", cutoff)
        .execute()
    )
    for row in stale.data:
        _force_close(row)
