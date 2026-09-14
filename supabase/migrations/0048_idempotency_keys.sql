-- Closes a real gap flagged while auditing offline-connection resilience:
-- no endpoint anywhere accepted an idempotency key, so if a request actually
-- succeeded server-side but its response never reached the client (the real
-- failure mode on a flaky connection, as opposed to a request that never
-- left the device), any retry or offline-queue replay -- including the
-- *existing* POS/staff-clock queues, not just new client work -- would
-- create a genuine duplicate: a second charge, a second digital order, a
-- second reservation.
--
-- One shared table rather than a column-per-table: a client generates one
-- uuid per submission attempt and resends the SAME key on every retry/replay
-- of that attempt. The three at-risk endpoints (POST /transactions,
-- POST /public/orders, POST /public/reservations) check this table first;
-- a hit means "this exact submission already succeeded" and the original
-- resource is returned instead of creating a second one.

create table idempotency_keys (
  key uuid primary key,
  endpoint text not null,
  resource_id uuid not null,
  created_at timestamptz not null default now()
);

-- RLS ---------------------------------------------------------------------
-- Fail-closed, same posture as every other table here -- all access is via
-- the FastAPI service-role client, which bypasses RLS. No anon/authenticated
-- policies needed or added.
alter table idempotency_keys enable row level security;
