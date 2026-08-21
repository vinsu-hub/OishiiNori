-- Utility meter readings/consumption per business day. Single-tenant: no
-- branch scoping, so utility_type + business_date is enough to identify a
-- reading. Includes gas (batch consumption, not a meter delta) directly
-- rather than as a later patch, since this is a fresh build.

create type utility_type as enum ('electricity', 'water', 'gas');

create table utility_logs (
  id uuid primary key default gen_random_uuid(),
  utility_type utility_type not null,
  business_date date not null,
  reading_start numeric, -- electricity/water only
  reading_end numeric,   -- electricity/water only
  quantity numeric,       -- gas only: tank/canister consumption
  unit_label text,        -- gas only
  days_covered int check (days_covered is null or (days_covered >= 1 and days_covered <= 7)), -- gas only: batch covers 1-7 days
  unit_cost numeric not null, -- cost per unit (kWh, cubic meter, canister, etc.)
  recorded_by uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Electricity/water: one reading per type per day. Gas: a single entry can
-- cover up to 7 days and multiple gas logs may share a business_date, so
-- the uniqueness constraint is scoped to electricity/water only.
create unique index utility_logs_meter_unique
  on utility_logs (utility_type, business_date)
  where utility_type in ('electricity', 'water');

create index idx_utility_logs_date on utility_logs(business_date);
create index idx_utility_logs_type on utility_logs(utility_type);

create view utility_consumption as
select
  ul.id,
  ul.utility_type,
  ul.business_date,
  ul.reading_start,
  ul.reading_end,
  coalesce(ul.reading_end - ul.reading_start, ul.quantity) as consumption,
  ul.unit_cost,
  coalesce(ul.reading_end - ul.reading_start, ul.quantity) * ul.unit_cost as cost,
  ul.recorded_by,
  ul.created_at,
  ul.updated_at,
  ul.quantity,
  ul.unit_label,
  ul.days_covered
from utility_logs ul
where ul.reading_end is not null or ul.quantity is not null;

-- RLS ---------------------------------------------------------------------
alter table utility_logs enable row level security;

create policy "Authenticated users can read utility logs"
  on utility_logs for select
  using (auth.role() = 'authenticated');
