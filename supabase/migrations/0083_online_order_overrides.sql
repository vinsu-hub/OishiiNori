-- Cashier overrides on online orders: change the payment method, edit the
-- items, or move the order to a later date. Each one needs a reason and is
-- recorded here. digital_orders.edit_revision stops two cashiers overwriting
-- each other; kitchen_change_note tells the kitchen what changed on the ticket.

create table online_order_changes (
  id uuid primary key default gen_random_uuid(),
  digital_order_id uuid not null references digital_orders(id) on delete cascade,
  transaction_id uuid references transactions(id) on delete set null,
  kind text not null check (kind in ('payment', 'items', 'schedule')),
  before jsonb not null default '{}'::jsonb,
  after jsonb not null default '{}'::jsonb,
  reason text not null,
  reference text,
  changed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_online_order_changes_order on online_order_changes (digital_order_id, created_at);

-- Fail-closed, same posture as every other table here: all access goes
-- through the FastAPI service-role client.
alter table online_order_changes enable row level security;

alter table digital_orders add column if not exists edit_revision integer not null default 0;
alter table transactions add column if not exists kitchen_change_note text;

-- The Online Orders board shows these, so a new one must refresh its cache.
create trigger online_order_changes_bump_live_version
  after insert or update or delete on online_order_changes
  for each statement execute function bump_live_version();
