-- Table Reservation feature. `tables` is the real managed entity that was
-- explicitly deferred when digital_orders.table_number was locked as a bare
-- int (see 0016's header) -- reservations need real capacity data to
-- auto-assign against, so that deferral ends here. digital_orders.table_number
-- is untouched; the two features do not share a table concept.
--
-- Slot-holding happens at submission time, not confirm time: a `pending`
-- reservation already occupies its table+time window exactly like
-- `confirmed` does. Only `declined`/`cancelled` free the slot. See
-- app/routers/reservations.py's availability-engine helpers for the query
-- this schema is shaped for.

create table tables (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  capacity int not null check (capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (label)
);

create type reservation_status as enum ('pending', 'confirmed', 'declined', 'cancelled');

create table reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_number bigint generated always as identity,
  table_id uuid not null references tables(id) on delete restrict,
  party_size int not null check (party_size > 0),
  reservation_date date not null,
  -- Stored, not derived, so the overlap query is a plain time comparison
  -- with no arithmetic needed in SQL or at query time.
  start_time time not null,
  end_time time not null,
  status reservation_status not null default 'pending',
  customer_name text not null,
  customer_phone text not null,
  customer_note text,
  declined_reason text,
  confirmed_by uuid references profiles(id) on delete set null,
  confirmed_at timestamptz,
  declined_by uuid references profiles(id) on delete set null,
  declined_at timestamptz,
  cancelled_by uuid references profiles(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);

-- The availability query always filters table_id + reservation_date first
-- (cheap equality on a handful of candidate tables), then range-compares
-- start/end in application code -- this composite index makes that first
-- step an index lookup instead of a scan, same reasoning as 0024's indexes.
create index idx_reservations_table_date on reservations(table_id, reservation_date);
create index idx_reservations_status on reservations(status);
create index idx_reservations_date on reservations(reservation_date);

-- closed_weekdays uses Python's date.weekday() convention (0=Monday..
-- 6=Sunday) so the backend never needs to convert -- documented here since
-- it's a common source of off-by-one bugs.
alter table business_settings
  add column open_time time not null default '10:00',
  add column close_time time not null default '21:00',
  add column closed_weekdays smallint[] not null default '{}';

-- RLS ---------------------------------------------------------------------
-- Fail-closed, same posture as digital_orders (0016) -- both public and
-- staff endpoints go through the FastAPI service-role client, which
-- bypasses RLS entirely. No anon/authenticated policies needed or added.
alter table tables enable row level security;
alter table reservations enable row level security;
