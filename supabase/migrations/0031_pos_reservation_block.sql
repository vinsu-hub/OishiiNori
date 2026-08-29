-- Reservation-to-POS table sync. The reservations feature (0025) built a real
-- `tables` registry (uuid/label/capacity/active), but the POS still records
-- `transactions.table_number` as a bare, FK-less int (deliberately, per 0016
-- and 0027). Confirming a reservation therefore had no effect on the POS: a
-- host could seat a walk-in at a table just confirmed for that exact slot.
--
-- This migration bridges the two: a nullable `pos_table_number` links a
-- registry table to the integer a cashier types, and `reservation_overrides`
-- is the audit trail for a manager deliberately seating a walk-in on a
-- reservation-blocked table. Enforcement lives in app/routers/transactions.py
-- (create_transaction) and app/routers/reservations.py (the /pos/tables/*
-- endpoints); this schema is shaped for those.

-- Nullable: a table only starts blocking the POS once a manager assigns its
-- POS number in the Tables tab. Unique so a typed int maps to at most one table.
alter table tables add column pos_table_number int unique check (pos_table_number > 0);

-- One row per manager override event. Consumed by exactly one transaction
-- (transaction_id stamped after that sale's insert succeeds); a row with a
-- null transaction_id older than the create_transaction freshness window is
-- simply dead.
create table reservation_overrides (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete restrict,
  table_id uuid not null references tables(id) on delete restrict,
  pos_table_number int not null,
  overridden_by uuid not null references profiles(id) on delete restrict,
  reason text not null,
  transaction_id uuid references transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_reservation_overrides_reservation on reservation_overrides(reservation_id);

-- Fail-closed, same posture as tables/reservations (0025): all access is via
-- the FastAPI service-role client, which bypasses RLS. No anon/authenticated
-- policies needed or added.
alter table reservation_overrides enable row level security;
