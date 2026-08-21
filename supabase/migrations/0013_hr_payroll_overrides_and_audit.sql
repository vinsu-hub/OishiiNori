-- HR never hand-edits a computed payroll amount -- they edit attendance or
-- create a logged override (reason + approver required) that feeds back
-- into payroll generation. One row per corrected field per shift.

create table hr.payroll_overrides (
  id uuid primary key default gen_random_uuid(),
  attendance_log_id uuid not null references hr.attendance_logs(id) on delete cascade,
  field text not null check (field in ('regular_hours', 'overtime_hours', 'night_diff_hours', 'day_scenario')),
  old_value text,
  new_value text not null,
  reason text not null,
  requested_by uuid not null references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create index idx_hr_payroll_overrides_log on hr.payroll_overrides(attendance_log_id);
create index idx_hr_payroll_overrides_approved on hr.payroll_overrides(approved_by);

-- Payroll-scoped audit trail (not a generic app-wide audit system) --
-- covers holiday CRUD, pay-rule changes, override create/approve, and
-- pay-rate edits. Written only by the backend's service-role client.
create table hr.payroll_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_value jsonb,
  new_value jsonb,
  reason text,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index idx_hr_payroll_audit_log_entity on hr.payroll_audit_log(entity_type, entity_id);
create index idx_hr_payroll_audit_log_created on hr.payroll_audit_log(created_at);

alter table hr.payroll_overrides enable row level security;
alter table hr.payroll_audit_log enable row level security;

-- service_role-only, same rationale as 0010.
