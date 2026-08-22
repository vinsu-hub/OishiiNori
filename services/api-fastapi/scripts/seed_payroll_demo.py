"""
Disposable payroll demo-data seed -- Oishii Nori Command Suite.

Creates 5 realistic demo employees (real accounts, via the real POST
/employees endpoint) and a real ~2-week attendance history for them
(June 1-15, 2026 -- a fully-completed semimonthly period), then generates
a real payroll record for that period via the real POST /payroll endpoint.
This is for a client-facing demo: the resulting data is meant to persist,
not be cleaned up.

hr.attendance_logs rows have no admin/backfill API (they're only ever
created by kiosk.py's clock-in/clock-out, which always stamps
datetime.now()) -- so this script inserts them directly via the
service-role Supabase client, but computes every derived field
(hours_worked/regular_hours/overtime_hours/night_diff_hours/day_scenario/
holiday_id) with the REAL pay-engine function, compute_attendance_breakdown,
imported directly from app.attendance_utils -- not reimplemented by hand --
so this data is exactly as correct as a real clock-in/out would produce.
Payroll generation itself goes through the real POST /payroll endpoint
against that seeded attendance, so the numbers are genuinely computed by
_compute_payroll_summary, not fabricated.

Idempotent: reruns reuse existing demo employees (matched by email) and
replace (delete + reinsert) their June 1-15 attendance rows rather than
duplicating them. Skips payroll generation if a record for this exact
period already exists.

Run with:  py -3 services/api-fastapi/scripts/seed_payroll_demo.py
"""
import os
import sys

# Windows consoles often default to cp1252, which can't encode PHP -- force
# utf-8 stdout so print() never crashes on it.
sys.stdout.reconfigure(encoding="utf-8")
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

# Make `app.*` importable regardless of cwd -- scripts/ is one level below
# services/api-fastapi, which is where the `app` package lives.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.attendance_utils import PH_UTC_OFFSET, compute_attendance_breakdown  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
API_BASE = os.environ.get("QA_API_BASE", "http://localhost:8000")

PERIOD_START = date(2026, 6, 1)
PERIOD_END = date(2026, 6, 15)

# A second, separate demo: one employee with a FULL calendar month of
# attendance (as opposed to the semimonthly period above), to demo
# generating payroll over a full-month period specifically. July has no
# seeded 2026 holiday, so this is deliberately the "plain month, mostly
# regular days plus a little overtime" case -- a different flavor of demo
# than the June period's scenario variety.
MONTH_PERIOD_START = date(2026, 7, 1)
MONTH_PERIOD_END = date(2026, 7, 31)

admin = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def ph_dt(y: int, m: int, d: int, h: int, mi: int = 0) -> datetime:
    """A UTC datetime whose Philippines-local wall-clock reading is
    y-m-d h:mi -- e.g. ph_dt(2026,6,12,9,0) is "9am Philippines time on
    June 12", stored as the correct UTC instant."""
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc) - PH_UTC_OFFSET


def get_exec_token() -> str:
    auth_client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    session = auth_client.auth.sign_in_with_password(
        {"email": "qa.tester@oishiinori.com", "password": "oishii1234-qa"}
    )
    return session.session.access_token


# --- Demo roster ------------------------------------------------------
# Each employee's shift dates deliberately exercise a different DOLE
# scenario so the payroll table shows real variety, not five identical
# regular_day rows. All shifts default to 8h (09:00-17:00 PH) except
# where noted.
EMPLOYEES = [
    {
        "full_name": "Maria Santos",
        "role": "employee",
        "department": "kitchen",
        "position": "Cashier",
        "pay_rate": 85.0,
        "days": [1, 2, 3, 4, 5, 8, 9, 10, 11, 13],
        "overtime_days": [],
        "night_shift_day": None,
        "rest_day": None,
    },
    {
        "full_name": "Juan Dela Cruz",
        "role": "employee",
        "department": "kitchen",
        "position": "Kitchen Staff",
        "pay_rate": 80.0,
        "days": [1, 2, 3, 4, 5, 8, 9, 10, 11, 13],
        "overtime_days": [9, 10],  # these two days run 08:00-18:00 (10h) instead of 8h
        "night_shift_day": None,
        "rest_day": None,
    },
    {
        "full_name": "Ana Reyes",
        "role": "employee",
        "department": "cafe",
        "position": "Barista",
        "pay_rate": 85.0,
        "days": [1, 2, 3, 4, 5, 8, 9, 10, 11, 12],  # includes June 12, Independence Day
        "overtime_days": [],
        "night_shift_day": None,
        "rest_day": None,
    },
    {
        "full_name": "Mark Villanueva",
        "role": "manager",
        "department": "kitchen",
        "position": "Shift Supervisor",
        "pay_rate": 110.0,
        "days": [1, 2, 3, 4, 5, 8, 10, 11, 13],  # 9 excluded here -- it's the night shift below
        "overtime_days": [],
        "night_shift_day": 9,  # 22:00 June 9 -> 06:00 June 10 PH time
        "rest_day": None,
    },
    {
        "full_name": "Rico Bautista",
        "role": "employee",
        "department": "kitchen",
        "position": "Kitchen Staff",
        "pay_rate": 80.0,
        "days": [1, 2, 3, 4, 5, 8, 9, 10, 11, 14],  # 14 is the rest day worked (is_rest_day=True below)
        "overtime_days": [],
        "night_shift_day": None,
        "rest_day": 14,
    },
]


# Full-month demo employee (separate from the June semimonthly roster above).
MONTH_EMPLOYEE = {
    "full_name": "Liza Fernandez",
    "role": "employee",
    "department": "cafe",
    "position": "Waitstaff",
    "pay_rate": 82.0,
}


def ensure_employee(spec: dict, exec_headers: dict) -> str:
    email_guess = spec["full_name"].lower().replace(" ", ".") + "@oishiinori.com"
    existing = admin.table("profiles").select("id, full_name").eq("full_name", spec["full_name"]).maybe_single().execute()
    if existing and existing.data:
        print(f"  reusing existing employee: {spec['full_name']} ({existing.data['id']})")
        return existing.data["id"]

    resp = requests.post(
        f"{API_BASE}/employees",
        json={
            "full_name": spec["full_name"],
            "role": spec["role"],
            "department": spec["department"],
            "position": spec["position"],
            "pay_rate": spec["pay_rate"],
        },
        headers=exec_headers,
    )
    resp.raise_for_status()
    body = resp.json()
    print(f"  created employee: {spec['full_name']} -- {body['email']} / {body['default_password']} (₱{spec['pay_rate']}/hr)")
    return body["id"]


def build_attendance_rows(employee_id: str, spec: dict) -> list[dict]:
    rows = []
    for day in spec["days"]:
        if day == spec.get("night_shift_day"):
            continue  # handled separately below
        h = 10 if day in spec["overtime_days"] else 8
        clock_in = ph_dt(2026, 6, day, 9, 0)
        clock_out = clock_in + timedelta(hours=h)
        is_rest_day = day == spec.get("rest_day")
        breakdown = compute_attendance_breakdown(clock_in, clock_out, is_rest_day)
        rows.append(
            {
                "employee_id": employee_id,
                "kiosk_id": None,
                "clock_in": clock_in.isoformat(),
                "clock_out": clock_out.isoformat(),
                "date": date(2026, 6, day).isoformat(),
                "is_rest_day": is_rest_day,
                "status": "completed",
                "auto_closed": False,
                **breakdown,
            }
        )

    night_day = spec.get("night_shift_day")
    if night_day:
        clock_in = ph_dt(2026, 6, night_day, 22, 0)
        clock_out = ph_dt(2026, 6, night_day + 1, 6, 0)
        breakdown = compute_attendance_breakdown(clock_in, clock_out, False)
        rows.append(
            {
                "employee_id": employee_id,
                "kiosk_id": None,
                "clock_in": clock_in.isoformat(),
                "clock_out": clock_out.isoformat(),
                "date": date(2026, 6, night_day).isoformat(),
                "is_rest_day": False,
                "status": "completed",
                "auto_closed": False,
                **breakdown,
            }
        )
    return rows


def build_full_month_attendance_rows(
    employee_id: str, year: int, month: int, overtime_days: set[int] | None = None
) -> list[dict]:
    """Regular 8h shifts (09:00-17:00 PH) on every weekday of the given
    month, skipping Sat/Sun -- computed from the real calendar via
    date.weekday() rather than a hand-picked day list, to avoid the kind
    of "forgot to include one day" mistake a manual list invites."""
    overtime_days = overtime_days or set()
    rows = []
    day = 1
    while True:
        try:
            d = date(year, month, day)
        except ValueError:
            break  # ran past the end of the month
        if d.weekday() < 5:  # Monday=0 .. Friday=4
            h = 10 if day in overtime_days else 8
            clock_in = ph_dt(year, month, day, 9, 0)
            clock_out = clock_in + timedelta(hours=h)
            breakdown = compute_attendance_breakdown(clock_in, clock_out, False)
            rows.append(
                {
                    "employee_id": employee_id,
                    "kiosk_id": None,
                    "clock_in": clock_in.isoformat(),
                    "clock_out": clock_out.isoformat(),
                    "date": d.isoformat(),
                    "is_rest_day": False,
                    "status": "completed",
                    "auto_closed": False,
                    **breakdown,
                }
            )
        day += 1
    return rows


def generate_payroll(exec_headers: dict, period_start: date, period_end: date) -> dict:
    """POST /payroll has no upsert -- it always inserts a new record, so a
    rerun would otherwise leave a stale duplicate (with the previous run's
    numbers) sitting in HRPayroll.tsx's History tab alongside the fresh
    one. No DELETE /payroll/{id} endpoint exists either, so removing a
    prior record for the same period goes direct via the service-role
    client, same as the attendance rows."""
    existing_records = requests.get(f"{API_BASE}/payroll?limit=50", headers=exec_headers).json()
    stale = [
        r for r in existing_records
        if r["period_start"] == period_start.isoformat() and r["period_end"] == period_end.isoformat()
    ]
    for rec in stale:
        admin.schema("hr").table("payroll_items").delete().eq("payroll_record_id", rec["id"]).execute()
        admin.schema("hr").table("payroll_records").delete().eq("id", rec["id"]).execute()
        print(f"  removed stale payroll record for this period (id={rec['id']}) before regenerating")

    gen_resp = requests.post(
        f"{API_BASE}/payroll",
        json={"period_start": period_start.isoformat(), "period_end": period_end.isoformat()},
        headers=exec_headers,
    )
    gen_resp.raise_for_status()
    record = gen_resp.json()
    print(f"  payroll record generated: id={record['id']}")
    print(f"  total_hours={record['total_hours']}  total_pay=₱{record['total_pay']:.2f}  employee_count={record['employee_count']}")
    for item in record["items"]:
        print(
            f"    {item['employee_name']:<20} {item['hours_worked']:>6.2f}h  "
            f"reg={item['regular_hours']:.1f} ot={item['overtime_hours']:.1f} nd={item['night_diff_hours']:.1f}  "
            f"-> ₱{item['total_pay']:.2f}"
        )
    return record


def main():
    print(f"== Oishii Nori payroll demo seed -- API base: {API_BASE} ==\n")
    try:
        health = requests.get(f"{API_BASE}/health", timeout=5)
    except requests.exceptions.ConnectionError:
        print(f"Cannot reach {API_BASE} -- is `uvicorn app.main:app --port 8000` running? Aborting.")
        sys.exit(1)
    if health.status_code != 200:
        print(f"GET /health returned {health.status_code}, aborting.")
        sys.exit(1)

    exec_token = get_exec_token()
    exec_headers = {"Authorization": f"Bearer {exec_token}"}

    print("Ensuring demo employees exist...")
    employee_ids = {}
    for spec in EMPLOYEES:
        employee_ids[spec["full_name"]] = ensure_employee(spec, exec_headers)

    print(f"\nSeeding attendance for {PERIOD_START} to {PERIOD_END}...")
    for spec in EMPLOYEES:
        emp_id = employee_ids[spec["full_name"]]
        # Idempotent: clear this employee's rows in the demo period first,
        # then reinsert fresh, rather than accumulating duplicates on rerun.
        admin.schema("hr").table("attendance_logs").delete().eq("employee_id", emp_id).gte(
            "date", PERIOD_START.isoformat()
        ).lte("date", PERIOD_END.isoformat()).execute()

        rows = build_attendance_rows(emp_id, spec)
        admin.schema("hr").table("attendance_logs").insert(rows).execute()
        print(f"  {spec['full_name']}: {len(rows)} attendance rows inserted")

    print("\nGenerating payroll record (semimonthly demo)...")
    generate_payroll(exec_headers, PERIOD_START, PERIOD_END)

    # --- Full-month demo: one employee, one full calendar month ---------
    print(f"\nEnsuring full-month demo employee exists...")
    month_employee_id = ensure_employee(MONTH_EMPLOYEE, exec_headers)

    print(f"\nSeeding attendance for {MONTH_PERIOD_START} to {MONTH_PERIOD_END} (Liza Fernandez)...")
    admin.schema("hr").table("attendance_logs").delete().eq("employee_id", month_employee_id).gte(
        "date", MONTH_PERIOD_START.isoformat()
    ).lte("date", MONTH_PERIOD_END.isoformat()).execute()
    month_rows = build_full_month_attendance_rows(
        month_employee_id, MONTH_PERIOD_START.year, MONTH_PERIOD_START.month, overtime_days={8, 22}
    )
    admin.schema("hr").table("attendance_logs").insert(month_rows).execute()
    print(f"  Liza Fernandez: {len(month_rows)} attendance rows inserted (every weekday in July, 2 with overtime)")

    print("\nGenerating payroll record (full-month demo)...")
    generate_payroll(exec_headers, MONTH_PERIOD_START, MONTH_PERIOD_END)

    print("\nDone. View this on HRPayroll.tsx (History tab) or Employees.tsx.")


if __name__ == "__main__":
    main()
