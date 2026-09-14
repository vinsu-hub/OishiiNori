-- Reservation ticket workflow: decouples "a reservation holds a slot" from
-- "a reservation is pinned to a physical table." Previously
-- POST /public/reservations auto-assigned + committed a specific table_id
-- the instant a booking was submitted (0025), and the Floor Plan's tapped
-- ticket just deep-linked straight into the POS pre-seated (no cashier
-- decision point). The client wants the cashier to explicitly place a
-- ticket onto a table, and "guest arrived" to be a separate action from
-- "table got assigned." See app/routers/reservations.py's reworked
-- availability engine (bin-packing over capacity, not a committed table)
-- for the logic this schema is shaped for.
--
-- table_id is now nullable: NULL from submission until a cashier calls
-- POST /reservations/{id}/place, which sets table_id + placed_at/placed_by.
-- _blocking_reservation (POS table-block logic) is restricted to placed
-- (table_id IS NOT NULL) reservations only -- an unplaced confirmed
-- reservation holds capacity for the slot-availability engine but does not
-- lock any specific POS table.

alter table reservations
  alter column table_id drop not null,
  add column placed_at timestamptz,
  add column placed_by uuid references profiles(id) on delete set null,
  add column arrived_at timestamptz,
  add column has_advance_order boolean not null default false,
  add column advance_order_fired_at timestamptz;

-- Advance order taken at booking time (optional). A staging area exactly
-- like digital_order_items/digital_order_addons (0016/0017) -- converted
-- into a real transaction by the fire-advance-orders job a fixed lead time
-- before start_time, via the same _create_transaction_row path every other
-- sale (POS, digital-menu approval) goes through.

create table reservation_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,
  product_size_id uuid not null references product_sizes(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  held_ingredients text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now()
);

create table reservation_item_addons (
  id uuid primary key default gen_random_uuid(),
  reservation_item_id uuid not null references reservation_items(id) on delete cascade,
  addon_id uuid not null references menu_addons(id) on delete restrict,
  quantity int not null check (quantity > 0)
);

create index idx_reservation_items_reservation on reservation_items(reservation_id);
create index idx_reservation_item_addons_item on reservation_item_addons(reservation_item_id);

-- Add-Order: a customer asking for more items after their order was already
-- charged creates a NEW transaction (own charge, own inventory deduction,
-- own kitchen ticket) linked back to the original, rather than mutating a
-- completed/reconciled transaction -- keeps existing P&L/void/refund logic,
-- which all assume a transaction is a closed atomic unit, untouched.
alter table transactions
  add column related_transaction_id uuid references transactions(id) on delete set null;

create index idx_transactions_related on transactions(related_transaction_id);

-- RLS -----------------------------------------------------------------------
-- Fail-closed, same posture as every other table here -- all access is via
-- the FastAPI service-role client, which bypasses RLS. No anon/authenticated
-- policies needed or added.
alter table reservation_items enable row level security;
alter table reservation_item_addons enable row level security;
