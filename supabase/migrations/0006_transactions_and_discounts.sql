-- POS transactions, transaction line items, and discount types.
--
-- JUDGMENT CALL: transaction_items references product_sizes(id) rather
-- than products(id) (SMFC referenced products directly since it had no
-- size tiers) — needed here so a line item's price ties to the specific
-- size actually sold.
--
-- JUDGMENT CALL (scope): includes the discount/void/tax audit columns
-- (mirroring the SMFC reference's discount_types + transactions columns)
-- since discount_types is an explicitly requested table and is only
-- useful wired into transactions. Deliberately EXCLUDES order-fulfillment/
-- KDS columns (fulfilled/fulfilled_at, held_ingredient_ids, kitchen
-- workflow status) — the task explicitly calls bundle fulfillment logging
-- a Phase 2/KDS concern, and the same reasoning extends to order-fulfillment
-- tracking in general for this Phase 1 pass.

create type transaction_status as enum ('open', 'closed', 'voided');

create table discount_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  percentage numeric not null check (percentage >= 0 and percentage <= 100),
  -- Senior/PWD are legally VAT-exempt (RA 9994 / RA 10754) in addition to
  -- the percentage off, so this is a first-class flag rather than
  -- something inferred from the discount's name.
  vat_exempt boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references profiles(id),
  status transaction_status not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  total_amount numeric(12, 2) not null default 0,
  discount_type_id uuid references discount_types(id) on delete set null,
  discount_amount numeric(12, 2) not null default 0,
  -- Stored for receipts/audit only, deliberately NOT folded into
  -- total_amount.
  tax_amount numeric(12, 2) not null default 0,
  is_owner_request boolean not null default false,
  owner_request_by uuid references profiles(id) on delete set null,
  owner_request_note text,
  voided_by uuid references profiles(id) on delete set null,
  voided_at timestamptz,
  void_reason text
);

create table transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  product_size_id uuid not null references product_sizes(id),
  quantity numeric(10, 2) not null check (quantity > 0),
  unit_price numeric(10, 2) not null check (unit_price >= 0)
);

create index idx_transactions_employee on transactions(employee_id);
create index idx_transactions_status on transactions(status);
create index idx_transactions_discount_type on transactions(discount_type_id);
create index idx_transaction_items_transaction on transaction_items(transaction_id);
create index idx_transaction_items_product_size on transaction_items(product_size_id);

-- RLS ---------------------------------------------------------------------
alter table discount_types enable row level security;
alter table transactions enable row level security;
alter table transaction_items enable row level security;

create policy "Authenticated users can read discount types"
  on discount_types for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can read transactions"
  on transactions for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can read transaction items"
  on transaction_items for select
  using (auth.role() = 'authenticated');
