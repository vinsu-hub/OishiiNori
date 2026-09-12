-- Online payment verification for delivery/pickup orders. Previously
-- payment_method was a fixed two-value CHECK ('gcash','cash'). The set of
-- e-wallet/bank-transfer methods (GCash, Maya, Maribank, ...) is now fully
-- admin-manageable, so payment_method becomes a plain text column storing
-- either the literal "cash" (unchanged built-in, no proof/verification
-- needed) or the chosen method's name -- denormalized at order time
-- (not a live FK) so renaming or deactivating a method later never
-- corrupts a historical order's record of what was actually used.

alter table digital_orders
  drop constraint digital_orders_payment_method_check;

alter table digital_orders
  add column payment_proof_url text;

create table online_payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  account_name text not null,
  account_number text not null,
  qr_code_url text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_online_payment_methods_active on online_payment_methods(active);

-- RLS -- same fail-closed posture as digital_orders/discount_types: only
-- the FastAPI service-role client ever touches this table (public GET for
-- checkout, executive-gated writes), so no anon/authenticated policies
-- are needed.
alter table online_payment_methods enable row level security;
