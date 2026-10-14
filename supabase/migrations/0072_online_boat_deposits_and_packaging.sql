-- Online packaging charges and refundable Sushi Boat deposits.
-- These are stored on the online order, while the deposit stays outside
-- transaction revenue. The deposit rows form the staff collection/return log.

alter table product_sizes
  add column if not exists deposit_amount numeric(12, 2) not null default 0
    check (deposit_amount >= 0);

alter table products
  add column if not exists takeout_bowl_eligible boolean not null default false;

update products
set takeout_bowl_eligible = coalesce(department = 'kitchen', false)
  and category not ilike '%extra%'
  and category <> 'Packaging';

update product_sizes ps
set deposit_amount = case
  when p.name in ('Small Sushi Boat', 'Medium Sushi Boat') then 1000
  when p.name = 'Large Sushi Boat' then 2500
  else 0
end
from products p
where p.id = ps.product_id;

alter table digital_orders
  add column if not exists packaging_fee numeric(12, 2) not null default 0,
  add column if not exists boat_deposit numeric(12, 2) not null default 0;

create table if not exists sushi_boat_deposits (
  id uuid primary key default gen_random_uuid(),
  digital_order_id uuid not null references digital_orders(id) on delete restrict,
  digital_order_item_id uuid not null references digital_order_items(id) on delete restrict,
  product_size_id uuid not null references product_sizes(id) on delete restrict,
  unit_number int not null check (unit_number > 0),
  amount numeric(12, 2) not null check (amount > 0),
  collected_at timestamptz,
  collected_by uuid references profiles(id) on delete set null,
  handoff_at timestamptz,
  handed_by uuid references profiles(id) on delete set null,
  return_due_at timestamptz,
  returned_at timestamptz,
  returned_by uuid references profiles(id) on delete set null,
  deduction_amount numeric(12, 2) not null default 0 check (deduction_amount >= 0),
  refund_amount numeric(12, 2) not null default 0 check (refund_amount >= 0),
  refund_method text,
  refund_reference text,
  notes text,
  created_at timestamptz not null default now(),
  unique (digital_order_item_id, unit_number),
  check (refund_amount + deduction_amount <= amount)
);

alter table sushi_boat_deposits
  add column if not exists handed_by uuid references profiles(id) on delete set null;

create index if not exists idx_sushi_boat_deposits_open
  on sushi_boat_deposits (collected_at, handoff_at, return_due_at, created_at desc);

alter table sushi_boat_deposits enable row level security;
