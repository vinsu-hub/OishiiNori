import io
import re
import secrets
import zipfile
from datetime import date, datetime, timezone

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from postgrest.exceptions import APIError

from app.attendance_utils import auto_close_stale_attendance, hr_table
from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app.payroll_pdf import build_payslip_pdf
from app.schemas import (
    AttendanceLogResponse,
    EmployeeCreate,
    EmployeeCreatedResponse,
    EmployeeOut,
    HolidayCreate,
    HolidayResponse,
    HolidayUpdate,
    PayMultiplierRuleResponse,
    PayMultiplierRuleUpdate,
    PayrollAuditLogResponse,
    PayrollGenerateRequest,
    PayrollOverrideCreate,
    PayrollOverrideResponse,
    PayrollRecordResponse,
    PayrollSummary,
    SetEmployeeActiveRequest,
    SetPinRequest,
)

router = APIRouter(tags=["hr"])

# Shared demo credential convention -- a manager-created account behaves the
# same as a seeded one. JUDGMENT CALL: not specified by the task.
_DEFAULT_PASSWORD = "oishii1234"
_DEFAULT_PIN = "1234"
_DEFAULT_PIN_HASH = bcrypt.hashpw(_DEFAULT_PIN.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

_FLAT_RULE = {"first_8hr_pct": 100.0, "ot_addon_pct": 0.0, "night_diff_addon_pct": 0.0}


@router.get("/attendance/me", response_model=AttendanceLogResponse | None)
def get_my_attendance(user: CurrentUser = Depends(get_current_user)):
    result = (
        hr_table("attendance_logs")
        .select("*")
        .eq("employee_id", user.id)
        .eq("date", date.today().isoformat())
        .order("created_at", desc=True)
        .limit(1)
        .maybe_single()
        .execute()
    )
    return result.data if result else None


@router.get("/attendance", response_model=list[AttendanceLogResponse])
def list_attendance(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    employee_id: str | None = Query(None),
    limit: int = Query(100, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    require_role(user, "manager", "executive")
    auto_close_stale_attendance()

    query = hr_table("attendance_logs").select(
        "id, employee_id, kiosk_id, clock_in, clock_out, date, hours_worked, regular_hours, "
        "overtime_hours, night_diff_hours, is_rest_day, holiday_id, day_scenario, status, "
        "auto_closed, created_at, updated_at"
    )
    if date_from:
        query = query.gte("date", date_from.isoformat())
    if date_to:
        query = query.lte("date", date_to.isoformat())
    if employee_id:
        query = query.eq("employee_id", employee_id)
    result = query.order("clock_in", desc=True).limit(limit).execute()
    return result.data


def _get_pay_multiplier_rules() -> dict[str, dict]:
    result = hr_table("pay_multiplier_rules").select("*").execute()
    return {r["scenario_key"]: r for r in (result.data or [])}


def _compute_pay_breakdown(
    regular_hours: float, overtime_hours: float, night_diff_hours: float, pay_rate: float, rule: dict
) -> dict:
    """DOLE-style breakdown for one attendance log. regular_pay bakes in the
    scenario's holiday/rest-day premium (first_8hr_pct); holiday_pay is
    reported separately as just the premium portion above a flat 100% rate.
    """
    first_8hr_pct = float(rule.get("first_8hr_pct", 100))
    ot_addon_pct = float(rule.get("ot_addon_pct", 0))
    night_diff_addon_pct = float(rule.get("night_diff_addon_pct", 0))

    regular_pay = regular_hours * pay_rate * (first_8hr_pct / 100)
    overtime_pay = overtime_hours * pay_rate * (first_8hr_pct / 100) * (1 + ot_addon_pct / 100)
    night_diff_pay = night_diff_hours * pay_rate * (night_diff_addon_pct / 100)
    holiday_pay = max(regular_pay - (regular_hours * pay_rate), 0.0)
    total_pay = regular_pay + overtime_pay + night_diff_pay

    return {
        "regular_pay": round(regular_pay, 2),
        "overtime_pay": round(overtime_pay, 2),
        "night_diff_pay": round(night_diff_pay, 2),
        "holiday_pay": round(holiday_pay, 2),
        "total_pay": round(total_pay, 2),
    }


def _compute_payroll_summary(supabase, date_from: date, date_to: date) -> dict:
    """Aggregate attendance hours x pay_rate over a date range using each
    log's persisted day_scenario/regular_hours/overtime_hours/
    night_diff_hours, DOLE holiday/OT/night-diff multiplier engine (always
    on in this build -- unlike the SMFC reference there is no
    payroll_rule_settings.engine_enabled flag in this schema)."""
    auto_close_stale_attendance()
    rules = _get_pay_multiplier_rules()

    attendance_result = (
        hr_table("attendance_logs")
        .select("*")
        .gte("date", date_from.isoformat())
        .lte("date", date_to.isoformat())
        .execute()
    )
    attendance_logs = attendance_result.data

    overrides_by_log: dict[str, list[dict]] = {}
    pending_overrides = 0
    if attendance_logs:
        log_ids = [log["id"] for log in attendance_logs]
        overrides_result = hr_table("payroll_overrides").select("*").in_("attendance_log_id", log_ids).execute()
        for o in overrides_result.data or []:
            overrides_by_log.setdefault(o["attendance_log_id"], []).append(o)
            if not o.get("approved_by"):
                pending_overrides += 1

    employee_ids = list({log["employee_id"] for log in attendance_logs})
    employees: dict[str, dict] = {}
    if employee_ids:
        employees_result = (
            supabase.table("profiles")
            .select("id, full_name, pay_rate, position")
            .in_("id", employee_ids)
            .execute()
        )
        employees = {e["id"]: e for e in employees_result.data}

    attendance_complete = all(log.get("hours_worked") is not None for log in attendance_logs)
    holiday_check = (
        hr_table("holidays")
        .select("id")
        .gte("holiday_date", date_from.isoformat())
        .lte("holiday_date", date_to.isoformat())
        .execute()
    )
    holiday_configured = bool(holiday_check.data) or not any(
        log.get("day_scenario")
        in (
            "regular_holiday",
            "regular_holiday_rest_day",
            "special_non_working",
            "special_non_working_rest_day",
            "special_working",
        )
        for log in attendance_logs
    )

    employee_agg: dict[str, dict] = {}
    for log in attendance_logs:
        emp_id = log["employee_id"]
        agg = employee_agg.setdefault(
            emp_id,
            {
                "hours": 0.0,
                "regular_hours": 0.0,
                "overtime_hours": 0.0,
                "night_diff_hours": 0.0,
                "regular_pay": 0.0,
                "overtime_pay": 0.0,
                "night_diff_pay": 0.0,
                "holiday_pay": 0.0,
                "total_pay": 0.0,
            },
        )
        hours = float(log.get("hours_worked", 0) or 0)
        agg["hours"] += hours

        emp = employees.get(emp_id, {})
        rate = float(emp.get("pay_rate", 0) or 0)

        applied = dict(log)
        for override in overrides_by_log.get(log["id"], []):
            if override.get("approved_by"):
                applied[override["field"]] = override["new_value"]

        regular_hours = float(applied.get("regular_hours") if applied.get("regular_hours") is not None else hours)
        overtime_hours = float(applied.get("overtime_hours") or 0)
        night_diff_hours = float(applied.get("night_diff_hours") or 0)
        scenario = applied.get("day_scenario") or "regular_day"
        rule = rules.get(scenario, _FLAT_RULE)

        breakdown = _compute_pay_breakdown(regular_hours, overtime_hours, night_diff_hours, rate, rule)
        agg["regular_hours"] += regular_hours
        agg["overtime_hours"] += overtime_hours
        agg["night_diff_hours"] += night_diff_hours
        agg["regular_pay"] += breakdown["regular_pay"]
        agg["overtime_pay"] += breakdown["overtime_pay"]
        agg["night_diff_pay"] += breakdown["night_diff_pay"]
        agg["holiday_pay"] += breakdown["holiday_pay"]
        agg["total_pay"] += breakdown["total_pay"]

    rows = []
    total_pay = 0.0
    total_hours = 0.0
    for emp_id, agg in employee_agg.items():
        emp = employees.get(emp_id, {})
        rate = float(emp.get("pay_rate", 0) or 0)
        row = {
            "employee_id": emp_id,
            "employee_name": emp.get("full_name") or "Unknown",
            "position": emp.get("position") or "",
            "hours_worked": round(agg["hours"], 2),
            "pay_rate": rate,
            "regular_hours": round(agg["regular_hours"], 2),
            "overtime_hours": round(agg["overtime_hours"], 2),
            "night_diff_hours": round(agg["night_diff_hours"], 2),
            "holiday_pay": round(agg["holiday_pay"], 2),
            "overtime_pay": round(agg["overtime_pay"], 2),
            "night_diff_pay": round(agg["night_diff_pay"], 2),
            "regular_pay": round(agg["regular_pay"], 2),
            "total_pay": round(agg["total_pay"], 2),
        }
        rows.append(row)
        total_pay += row["total_pay"]
        total_hours += agg["hours"]

    return {
        "period_start": date_from.isoformat(),
        "period_end": date_to.isoformat(),
        "rows": rows,
        "total_hours": round(total_hours, 2),
        "total_pay": round(total_pay, 2),
        "employee_count": len(rows),
        "validation": {
            "attendance_complete": attendance_complete,
            "holiday_configured": holiday_configured,
            "pending_overrides": pending_overrides,
        },
    }


@router.get("/attendance/summary", response_model=PayrollSummary)
def get_payroll_summary(
    date_from: date = Query(...),
    date_to: date = Query(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Preview payroll over a date range (not persisted)."""
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    return _compute_payroll_summary(supabase, date_from, date_to)


@router.post("/payroll", response_model=PayrollRecordResponse)
def generate_payroll(body: PayrollGenerateRequest, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    summary = _compute_payroll_summary(supabase, body.period_start, body.period_end)

    record_result = (
        hr_table("payroll_records")
        .insert(
            {
                "period_start": body.period_start.isoformat(),
                "period_end": body.period_end.isoformat(),
                "total_hours": summary["total_hours"],
                "total_pay": summary["total_pay"],
                "employee_count": summary["employee_count"],
                "generated_by": user.id,
            }
        )
        .execute()
    )
    record = record_result.data[0]

    items = []
    if summary["rows"]:
        items_result = (
            hr_table("payroll_items")
            .insert(
                [
                    {
                        "payroll_record_id": record["id"],
                        "employee_id": row["employee_id"],
                        "employee_name": row["employee_name"],
                        "position": row["position"],
                        "hours_worked": row["hours_worked"],
                        "pay_rate": row["pay_rate"],
                        "regular_hours": row.get("regular_hours"),
                        "overtime_hours": row.get("overtime_hours"),
                        "night_diff_hours": row.get("night_diff_hours"),
                        "regular_pay": row.get("regular_pay"),
                        "overtime_pay": row.get("overtime_pay"),
                        "holiday_pay": row.get("holiday_pay"),
                        "night_diff_pay": row.get("night_diff_pay"),
                        "total_pay": row["total_pay"],
                    }
                    for row in summary["rows"]
                ]
            )
            .execute()
        )
        items = items_result.data

    record["items"] = items
    return record


@router.get("/payroll", response_model=list[PayrollRecordResponse])
def list_payroll_records(limit: int = Query(50, le=200), user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    result = hr_table("payroll_records").select("*").order("created_at", desc=True).limit(limit).execute()
    records = result.data
    for record in records:
        record["items"] = []
    return records


def _fetch_employee_attendance_rows(employee_id: str, date_from: date, date_to: date) -> list[dict]:
    """Daily attendance_logs for one employee/period, shaped for
    build_payslip_pdf. payroll_records/items never persist this detail --
    it's always recomputed live from hr.attendance_logs."""
    return (
        hr_table("attendance_logs")
        .select("date, clock_in, clock_out, hours_worked, status, auto_closed")
        .eq("employee_id", employee_id)
        .gte("date", date_from.isoformat())
        .lte("date", date_to.isoformat())
        .order("date")
        .execute()
        .data
    )


@router.get("/payroll/receipt.pdf")
def get_payroll_receipt_pdf(
    employee_id: str = Query(...),
    period_start: date = Query(...),
    period_end: date = Query(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Real PDF payslip for one employee: header, pay summary, and a full
    daily time-log table. Must be registered before /payroll/{payroll_id}
    so this literal path isn't swallowed by that dynamic route."""
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    auto_close_stale_attendance()

    profile_result = (
        supabase.table("profiles")
        .select("id, full_name, employee_number, position, pay_rate")
        .eq("id", employee_id)
        .maybe_single()
        .execute()
    )
    if not profile_result or not profile_result.data:
        raise HTTPException(status_code=404, detail="Employee not found")
    profile = profile_result.data

    summary = _compute_payroll_summary(supabase, period_start, period_end)
    row = next((r for r in summary["rows"] if r["employee_id"] == employee_id), None)
    attendance_rows = _fetch_employee_attendance_rows(employee_id, period_start, period_end)

    pdf_bytes = build_payslip_pdf(
        employee=profile,
        company_name="Oishii Nori",
        period_start=period_start,
        period_end=period_end,
        hours_worked=row["hours_worked"] if row else 0.0,
        pay_rate=float(profile.get("pay_rate") or 0),
        total_pay=row["total_pay"] if row else 0.0,
        attendance_rows=attendance_rows,
        regular_hours=row.get("regular_hours") if row else None,
        overtime_hours=row.get("overtime_hours") if row else None,
        overtime_pay=row.get("overtime_pay") if row else None,
        night_diff_hours=row.get("night_diff_hours") if row else None,
        night_diff_pay=row.get("night_diff_pay") if row else None,
        holiday_pay=row.get("holiday_pay") if row else None,
    )
    safe_name = (profile.get("full_name") or "employee").replace(" ", "_")
    filename = f"payslip_{safe_name}_{period_start}_{period_end}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.get("/payroll/receipts.zip")
def get_payroll_receipts_zip(
    period_start: date = Query(...),
    period_end: date = Query(...),
    user: CurrentUser = Depends(get_current_user),
):
    """One PDF payslip per employee for a period, bundled into a ZIP --
    avoids the browser popup-blocker problem of opening one window per
    employee from the client."""
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    summary = _compute_payroll_summary(supabase, period_start, period_end)

    employee_ids = [row["employee_id"] for row in summary["rows"]]
    profiles: dict[str, dict] = {}
    if employee_ids:
        profiles_result = (
            supabase.table("profiles")
            .select("id, full_name, employee_number, position, pay_rate")
            .in_("id", employee_ids)
            .execute()
        )
        profiles = {p["id"]: p for p in profiles_result.data}

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for row in summary["rows"]:
            profile = profiles.get(row["employee_id"], {"full_name": row["employee_name"]})
            attendance_rows = _fetch_employee_attendance_rows(row["employee_id"], period_start, period_end)
            pdf_bytes = build_payslip_pdf(
                employee=profile,
                company_name="Oishii Nori",
                period_start=period_start,
                period_end=period_end,
                hours_worked=row["hours_worked"],
                pay_rate=row["pay_rate"],
                total_pay=row["total_pay"],
                attendance_rows=attendance_rows,
                regular_hours=row.get("regular_hours"),
                overtime_hours=row.get("overtime_hours"),
                overtime_pay=row.get("overtime_pay"),
                night_diff_hours=row.get("night_diff_hours"),
                night_diff_pay=row.get("night_diff_pay"),
                holiday_pay=row.get("holiday_pay"),
            )
            safe_name = (profile.get("full_name") or "employee").replace(" ", "_")
            zf.writestr(f"payslip_{safe_name}.pdf", pdf_bytes)

    filename = f"payroll_receipts_{period_start}_{period_end}.zip"
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/payroll/{payroll_id}", response_model=PayrollRecordResponse)
def get_payroll_record(payroll_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    record_result = hr_table("payroll_records").select("*").eq("id", payroll_id).maybe_single().execute()
    if not record_result or not record_result.data:
        raise HTTPException(status_code=404, detail="Payroll record not found")
    record = record_result.data
    items_result = hr_table("payroll_items").select("*").eq("payroll_record_id", payroll_id).execute()
    record["items"] = items_result.data
    return record


def _write_audit_log(
    actor_id: str,
    action: str,
    entity_type: str,
    entity_id: str | None,
    old_value: dict | None = None,
    new_value: dict | None = None,
    reason: str | None = None,
) -> None:
    hr_table("payroll_audit_log").insert(
        {
            "actor_id": actor_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "old_value": old_value,
            "new_value": new_value,
            "reason": reason,
        }
    ).execute()


# --- Holiday calendar ---


@router.get("/hr/holidays", response_model=list[HolidayResponse])
def list_holidays(year: int = Query(...), user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    result = (
        hr_table("holidays")
        .select("*")
        .gte("holiday_date", f"{year}-01-01")
        .lte("holiday_date", f"{year}-12-31")
        .order("holiday_date")
        .execute()
    )
    return result.data


@router.post("/hr/holidays", response_model=HolidayResponse)
def create_holiday(body: HolidayCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    payload = body.model_dump(mode="json")
    result = hr_table("holidays").insert(payload).execute()
    row = result.data[0]
    _write_audit_log(user.id, "create", "holiday", row["id"], new_value=payload)
    return row


@router.patch("/hr/holidays/{holiday_id}", response_model=HolidayResponse)
def update_holiday(holiday_id: str, body: HolidayUpdate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    existing = hr_table("holidays").select("*").eq("id", holiday_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Holiday not found")

    payload = {k: v for k, v in body.model_dump(mode="json").items() if v is not None}
    result = hr_table("holidays").update(payload).eq("id", holiday_id).execute()
    row = result.data[0]
    _write_audit_log(user.id, "update", "holiday", holiday_id, old_value=existing.data, new_value=payload)
    return row


@router.delete("/hr/holidays/{holiday_id}")
def delete_holiday(holiday_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    existing = hr_table("holidays").select("*").eq("id", holiday_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Holiday not found")

    hr_table("holidays").delete().eq("id", holiday_id).execute()
    _write_audit_log(user.id, "delete", "holiday", holiday_id, old_value=existing.data)
    return {"deleted": True}


# --- Pay multiplier rules ---


@router.get("/hr/pay-rules", response_model=list[PayMultiplierRuleResponse])
def list_pay_rules(user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    result = hr_table("pay_multiplier_rules").select("*").order("scenario_key").execute()
    return result.data


@router.patch("/hr/pay-rules/{scenario_key}", response_model=PayMultiplierRuleResponse)
def update_pay_rule(scenario_key: str, body: PayMultiplierRuleUpdate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    existing = hr_table("pay_multiplier_rules").select("*").eq("scenario_key", scenario_key).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Scenario not found")

    payload = {k: v for k, v in body.model_dump(mode="json").items() if v is not None}
    payload["updated_by"] = user.id
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = hr_table("pay_multiplier_rules").update(payload).eq("scenario_key", scenario_key).execute()
    row = result.data[0]
    _write_audit_log(
        user.id, "update", "pay_multiplier_rule", row["id"], old_value=existing.data, new_value=payload,
        reason=f"scenario={scenario_key}",
    )
    return row


# --- Payroll overrides ---


@router.post("/hr/payroll-overrides", response_model=PayrollOverrideResponse)
def create_payroll_override(body: PayrollOverrideCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    log_result = hr_table("attendance_logs").select("*").eq("id", body.attendance_log_id).maybe_single().execute()
    if not log_result or not log_result.data:
        raise HTTPException(status_code=404, detail="Attendance log not found")
    log = log_result.data

    old_value = log.get(body.field)
    payload = {
        "attendance_log_id": body.attendance_log_id,
        "field": body.field,
        "old_value": str(old_value) if old_value is not None else None,
        "new_value": body.new_value,
        "reason": body.reason,
        "requested_by": user.id,
    }
    result = hr_table("payroll_overrides").insert(payload).execute()
    row = result.data[0]
    _write_audit_log(
        user.id, "create", "payroll_override", row["id"],
        old_value={body.field: old_value}, new_value={body.field: body.new_value}, reason=body.reason,
    )
    return row


@router.patch("/hr/payroll-overrides/{override_id}/approve", response_model=PayrollOverrideResponse)
def approve_payroll_override(override_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "executive")
    existing = hr_table("payroll_overrides").select("*").eq("id", override_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Override not found")

    payload = {"approved_by": user.id, "approved_at": datetime.now(timezone.utc).isoformat()}
    result = hr_table("payroll_overrides").update(payload).eq("id", override_id).execute()
    row = result.data[0]
    _write_audit_log(user.id, "approve", "payroll_override", override_id, new_value=payload)
    return row


# --- Audit log ---


@router.get("/hr/payroll-audit-log", response_model=list[PayrollAuditLogResponse])
def list_payroll_audit_log(
    entity_type: str | None = Query(None),
    limit: int = Query(100, le=500),
    user: CurrentUser = Depends(get_current_user),
):
    require_role(user, "manager", "executive")
    query = hr_table("payroll_audit_log").select("*")
    if entity_type:
        query = query.eq("entity_type", entity_type)
    result = query.order("created_at", desc=True).limit(limit).execute()
    return result.data


# --- Employees (profiles) ---
# JUDGMENT CALL: not explicitly requested by the task, but nothing else can
# create the profiles/kiosk_pin_hash rows the rest of HR (and the kiosk)
# depend on -- profiles is empty on the live DB (Phase 1 only seeds public
# catalog tables). Structurally mirrors the SMFC reference's create_employee
# minus branch/theme_key.


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", ".", name.lower()).strip(".")
    return slug or "employee"


@router.get("/employees", response_model=list[EmployeeOut])
def list_employees(user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    result = (
        supabase.table("profiles")
        .select("id, full_name, role, department, position, pay_rate, employee_number, active")
        .order("full_name")
        .execute()
    )
    return result.data


@router.post("/employees", response_model=EmployeeCreatedResponse)
def create_employee(body: EmployeeCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()

    slug = _slugify(body.full_name)
    email = None
    for attempt in range(10):
        candidate = f"{slug}@oishiinori.com" if attempt == 0 else f"{slug}{attempt + 1}@oishiinori.com"
        existing_user = next((u for u in supabase.auth.admin.list_users() if u.email == candidate), None)
        if not existing_user:
            email = candidate
            break
    if email is None:
        raise HTTPException(status_code=500, detail="Could not generate a unique login email")

    created = supabase.auth.admin.create_user({"email": email, "password": _DEFAULT_PASSWORD, "email_confirm": True})
    user_id = created.user.id

    employee_number = None
    for _ in range(5):
        candidate = f"EMP-{secrets.token_hex(2).upper()}"
        conflict = (
            supabase.table("profiles").select("id").eq("employee_number", candidate).maybe_single().execute()
        )
        if not conflict or not conflict.data:
            employee_number = candidate
            break
    if employee_number is None:
        raise HTTPException(status_code=500, detail="Could not generate a unique employee number")

    supabase.table("profiles").insert(
        {
            "id": user_id,
            "role": body.role,
            "full_name": body.full_name,
            "department": body.department,
            "position": body.position,
            "pay_rate": body.pay_rate or 0,
            "employee_number": employee_number,
            "kiosk_pin_hash": _DEFAULT_PIN_HASH,
        }
    ).execute()

    profile_result = (
        supabase.table("profiles")
        .select("id, full_name, role, department, position, pay_rate, employee_number")
        .eq("id", user_id)
        .single()
        .execute()
    )
    profile = profile_result.data
    profile["email"] = email
    profile["default_password"] = _DEFAULT_PASSWORD
    profile["default_pin"] = _DEFAULT_PIN
    return profile


@router.patch("/employees/{employee_id}/pin")
def set_employee_pin(employee_id: str, body: SetPinRequest, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    existing = supabase.table("profiles").select("id").eq("id", employee_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Employee not found")

    kiosk_pin_hash = bcrypt.hashpw(body.pin.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    supabase.table("profiles").update({"kiosk_pin_hash": kiosk_pin_hash}).eq("id", employee_id).execute()
    return {"status": "ok"}


@router.patch("/employees/{employee_id}", response_model=EmployeeOut)
def set_employee_active(
    employee_id: str, body: SetEmployeeActiveRequest, user: CurrentUser = Depends(get_current_user)
):
    """Deactivate/reactivate -- the safe default for offboarding. A
    deactivated employee is blocked immediately from both dashboard login
    (get_current_user) and kiosk PIN use (verify_employee_pin), but every
    real record they're attached to (sales, attendance, inventory
    movements) stays intact and referenceable -- same soft-delete pattern
    products/discount_types already use, kept separate from
    set_employee_pin above rather than overloading one endpoint."""
    require_role(user, "manager", "executive")
    supabase = get_supabase()
    existing = supabase.table("profiles").select("id").eq("id", employee_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Employee not found")

    supabase.table("profiles").update({"active": body.active}).eq("id", employee_id).execute()
    profile_result = (
        supabase.table("profiles")
        .select("id, full_name, role, department, position, pay_rate, employee_number, active")
        .eq("id", employee_id)
        .single()
        .execute()
    )
    return profile_result.data


@router.delete("/employees/{employee_id}")
def delete_employee(employee_id: str, user: CurrentUser = Depends(get_current_user)):
    """Hard delete -- only ever succeeds for an account with zero real
    history (no sales, attendance, inventory movements, etc. referencing
    it). Executive-only: stricter than the manager+ gate on every other
    employee action here, since this is irreversible where Deactivate
    isn't. Rather than hardcoding every table that might reference
    profiles.id, this just attempts the delete and lets Postgres's own
    foreign-key violation (23503) say which table is blocking it -- the
    exact real error this session hit cleaning up a leftover test
    account, surfaced here as a clear 409 instead of a raw 500."""
    require_role(user, "executive")
    supabase = get_supabase()
    existing = supabase.table("profiles").select("id").eq("id", employee_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Employee not found")

    try:
        supabase.table("profiles").delete().eq("id", employee_id).execute()
    except APIError as e:
        if e.code == "23503":
            raise HTTPException(
                status_code=409,
                detail=f"Can't delete -- this employee has real history attached ({e.details or e.message}). "
                "Deactivate instead to block their login/PIN while keeping that history intact.",
            )
        raise

    supabase.auth.admin.delete_user(employee_id)
    return {"status": "ok"}
