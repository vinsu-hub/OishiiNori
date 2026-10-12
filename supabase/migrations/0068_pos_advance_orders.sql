-- POS takeout/delivery orders can be placed and paid before their ready time.
-- Null scheduled_for preserves every existing transaction's behavior.
alter table transactions
  add column scheduled_for timestamptz,
  add column pickup_customer_name text,
  add column pickup_customer_phone text,
  add column advance_schedule_revision integer not null default 0,
  add column advance_schedule_updated_at timestamptz,
  add column advance_schedule_updated_by uuid references profiles(id) on delete restrict;

create index idx_transactions_advance_schedule
  on transactions(scheduled_for, id) where scheduled_for is not null;
