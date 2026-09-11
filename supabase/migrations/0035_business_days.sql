-- WS-13: Business Day cycle. POS is locked each day until the cashier
-- confirms Start-of-Day (their OWN kiosk ID+PIN, re-verified the same way
-- Owner's Request (transactions.py) and the reservation override
-- (reservations.py) already do via verify_employee_pin) plus a
-- menu-up-to-date acknowledgement. End-of-Day records the cashier's
-- counted cash-register total; the system's own EOD revenue total is
-- computed and stored at close time for the admin-side variance review --
-- the cashier must never see it.
--
-- One row per PH business day (business_date), not a singleton like
-- business_settings (0023) -- closer in shape to transaction_daily_counters
-- (0033).

create table business_days (
  id uuid primary key default gen_random_uuid(),
  business_date date not null unique,
  opened_at timestamptz not null default now(),
  opened_by uuid not null references profiles(id) on delete restrict,
  menu_confirmed boolean not null default false,
  closed_at timestamptz,
  closed_by uuid references profiles(id) on delete restrict,
  cash_register_total numeric(12,2),
  system_eod_total numeric(12,2)
);

-- Fail-closed like reservation_overrides (0031) -- deliberately no RLS
-- policies. Only the FastAPI service-role client (which bypasses RLS)
-- reads/writes this table, so a cashier can never query it directly and
-- see cash_register_total/system_eod_total; the API's own response shape
-- (BusinessDayStatusOut) is what actually keeps those fields from a
-- cashier's eyes.
alter table business_days enable row level security;
