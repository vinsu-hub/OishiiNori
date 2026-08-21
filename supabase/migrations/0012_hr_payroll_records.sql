-- Persisted payroll runs. payroll_items carries the same holiday-pay
-- breakdown columns as hr.attendance_logs (0010) so a persisted run keeps
-- an accurate line-item record even if hr.pay_multiplier_rules change
-- later — same JUDGMENT CALL rationale as 0010 (needed for the
-- explicitly-requested pay_multiplier_rules table to be useful).

create table hr.payroll_records (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  total_hours numeric not null default 0,
  total_pay numeric not null default 0,
  employee_count integer not null default 0,
  generated_by uuid not null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_hr_payroll_records_period on hr.payroll_records(period_start, period_end);

create table hr.payroll_items (
  id uuid primary key default gen_random_uuid(),
  payroll_record_id uuid not null references hr.payroll_records(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  employee_name text not null,
  "position" text,
  hours_worked numeric not null default 0,
  pay_rate numeric not null default 0,
  regular_hours numeric,
  overtime_hours numeric,
  night_diff_hours numeric,
  regular_pay numeric,
  overtime_pay numeric,
  holiday_pay numeric,
  night_diff_pay numeric,
  total_pay numeric not null default 0,
  created_at timestamptz not null default now()
);

create index idx_hr_payroll_items_record on hr.payroll_items(payroll_record_id);
create index idx_hr_payroll_items_employee on hr.payroll_items(employee_id);

alter table hr.payroll_records enable row level security;
alter table hr.payroll_items enable row level security;

-- service_role-only, same rationale as 0010.
