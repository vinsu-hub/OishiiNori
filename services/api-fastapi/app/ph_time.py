"""Philippines-local calendar-day boundaries, shared by any router that
filters/aggregates "today" or a specific date -- transactions.py's
list_transactions, dashboard_summary.py's Command Center summary, and
analytics.py's Trend Analysis range. All timestamps are stored/compared as
true UTC everywhere else in this codebase; day-bucketing is the one place
that needs to know the caller means a Philippines calendar day, not a UTC
one -- mirrors the offset already used for night-differential hours in
attendance_utils.py's PH_UTC_OFFSET, kept here as its own copy since HR's
module is scoped to attendance/payroll, not general-purpose.
"""

from datetime import date, datetime, timedelta, timezone

PH_UTC_OFFSET = timedelta(hours=8)


def ph_day_bounds_utc(d: date) -> tuple[str, str]:
    """UTC ISO bounds of a Philippines-local calendar day `d`, i.e.
    [d 00:00 PH, d+1 00:00 PH) expressed in UTC."""
    local_start = datetime.combine(d, datetime.min.time()) - PH_UTC_OFFSET
    local_start = local_start.replace(tzinfo=timezone.utc)
    local_end = local_start + timedelta(days=1) - timedelta(microseconds=1)
    return local_start.isoformat(), local_end.isoformat()
