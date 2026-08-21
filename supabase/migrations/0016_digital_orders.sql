-- Digital menu (QR table ordering) -- customer scans a per-table QR code,
-- browses the menu, and submits an order with no login. This is a staging
-- area only: a digital_orders row is NOT a sale. Staff review + approve it
-- from a new dashboard page, and approving creates a real `transactions`
-- row (under the approving staff member's account) through the exact same
-- insert/deduction path a POS sale uses -- see services/api-fastapi's
-- `_create_transaction_row` helper. Rejecting a digital order never touches
-- `transactions` at all. This keeps the existing, already-tested sales/
-- kitchen pipeline completely untouched by this feature.
--
-- "Table" is deliberately just an integer, not a managed entity -- a QR
-- code encodes a URL with ?table=N, and N is never validated against a
-- pre-registered list (locked decision, see SESSION_HANDOFF.md).

create table digital_orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity,
  table_number int not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  payment_method text not null check (payment_method in ('gcash', 'cash')),
  customer_note text,
  subtotal numeric(12, 2) not null default 0,
  approved_by uuid references profiles(id) on delete set null,
  approved_at timestamptz,
  rejected_reason text,
  transaction_id uuid references transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table digital_order_items (
  id uuid primary key default gen_random_uuid(),
  digital_order_id uuid not null references digital_orders(id) on delete cascade,
  product_size_id uuid not null references product_sizes(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  unit_price numeric(12, 2) not null
);

create index idx_digital_order_items_order on digital_order_items(digital_order_id);
create index idx_digital_orders_status on digital_orders(status);

-- RLS ---------------------------------------------------------------------
-- Fail-closed, same posture as every other table here -- both the public
-- (unauthenticated) and staff-facing endpoints go through the FastAPI
-- service-role client, which bypasses RLS entirely. No anon/authenticated
-- policies are needed or added.
alter table digital_orders enable row level security;
alter table digital_order_items enable row level security;
