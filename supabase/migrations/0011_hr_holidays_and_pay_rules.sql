-- Holiday calendar and DOLE-style pay-multiplier rules for the payroll
-- engine. Single-tenant: no branch_scope column (SMFC's holidays could be
-- org-wide or branch-specific; here there's only one store).

create table hr.holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  holiday_type text not null check (holiday_type in ('regular_holiday', 'special_non_working', 'special_working')),
  is_recurring boolean not null default false,
  created_at timestamptz not null default now()
);

alter table hr.attendance_logs
  add constraint attendance_logs_holiday_id_fkey
  foreign key (holiday_id) references hr.holidays(id) on delete set null;

create index idx_hr_attendance_logs_holiday on hr.attendance_logs(holiday_id);
create index idx_hr_holidays_date on hr.holidays(holiday_date);

-- Editable pay-multiplier rules so future rate changes don't need a
-- deploy.
create table hr.pay_multiplier_rules (
  id uuid primary key default gen_random_uuid(),
  scenario_key text not null unique check (scenario_key in (
    'regular_day', 'regular_holiday', 'regular_holiday_rest_day',
    'special_non_working', 'special_non_working_rest_day',
    'special_working', 'rest_day'
  )),
  not_worked_pct numeric not null default 0,
  first_8hr_pct numeric not null default 100,
  ot_addon_pct numeric not null default 25,
  night_diff_addon_pct numeric not null default 10,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

alter table hr.holidays enable row level security;
alter table hr.pay_multiplier_rules enable row level security;

-- service_role-only, same rationale as 0010.
