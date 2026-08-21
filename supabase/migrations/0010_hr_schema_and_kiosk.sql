-- HR domain lives in its own `hr` Postgres schema (isolated from `public`),
-- same isolation pattern as the SMFC reference. Nothing in a dashboard app
-- is expected to query these tables directly via anon/authenticated keys —
-- everything goes through FastAPI's service-role client — so only
-- service_role gets blanket grants here. Reaching `hr` via PostgREST also
-- requires adding it to the Supabase project's Data API "Exposed schemas"
-- setting, which is Dashboard-only and not scriptable from a migration —
-- flagged in the handoff report as something to verify/set manually if
-- Phase 2 needs direct REST access to hr.* (FastAPI's direct Postgres
-- connection does not need this).

create schema if not exists hr;

grant usage on schema hr to service_role;
grant all on all tables in schema hr to service_role;
alter default privileges in schema hr grant all on tables to service_role;

-- Kiosk devices (Staff Clock terminals). Rows are lazily upserted by the
-- backend the first time a client-generated kiosk_id is seen, not manually
-- provisioned.
create table hr.kiosks (
  id uuid primary key default gen_random_uuid(),
  device_label text,
  created_at timestamptz not null default now()
);

-- Attendance logs. JUDGMENT CALL: includes the holiday-pay breakdown
-- columns (regular_hours/overtime_hours/night_diff_hours/is_rest_day/
-- holiday_id/day_scenario) even though only "attendance_logs" (bare) was
-- named in the task's table list — without them, hr.pay_multiplier_rules
-- (explicitly requested) has nothing to key off of. attendance_breaks
-- (break-tracking) was NOT added since it wasn't requested and nothing
-- else in the requested table set depends on it; status is therefore a
-- simple working/completed toggle with no on_break state.
create table hr.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  kiosk_id uuid references hr.kiosks(id),
  clock_in timestamptz not null,
  clock_out timestamptz,
  date date not null default current_date,
  hours_worked numeric,
  regular_hours numeric,
  overtime_hours numeric,
  night_diff_hours numeric,
  is_rest_day boolean not null default false,
  holiday_id uuid, -- fk added in 0011 after hr.holidays exists
  day_scenario text check (day_scenario in (
    'regular_day', 'regular_holiday', 'regular_holiday_rest_day',
    'special_non_working', 'special_non_working_rest_day',
    'special_working', 'rest_day'
  )),
  status text not null default 'working' check (status in ('working', 'completed')),
  auto_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_hr_attendance_logs_employee on hr.attendance_logs(employee_id);
create index idx_hr_attendance_logs_date on hr.attendance_logs(date);
create index idx_hr_attendance_logs_status on hr.attendance_logs(status);
create index idx_hr_attendance_logs_kiosk on hr.attendance_logs(kiosk_id);

-- Prevents two open shifts for the same employee on the same day (e.g. a
-- kiosk offline-queue replay firing twice) at the database level rather
-- than trusting a check-then-insert in application code.
create unique index attendance_logs_one_open_shift_per_day
  on hr.attendance_logs (employee_id, date)
  where status = 'working';

alter table hr.kiosks enable row level security;
alter table hr.attendance_logs enable row level security;

-- No authenticated-role policies: HR/attendance data is service_role-only
-- in this pass (see 0001's RLS note). Staff clock in/out via the FastAPI
-- kiosk routes using the service-role key, not a Supabase session.
