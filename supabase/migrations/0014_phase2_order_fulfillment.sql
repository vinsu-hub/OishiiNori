-- PHASE 2 ADDITION (services/api-fastapi) -- flagged as a judgment call in
-- the Phase 2 backend handoff report, not a Phase 1 change.
--
-- Migrations 0001-0013 are Phase 1's territory and are left untouched.
-- However, two features the Phase 2 task explicitly asks the API layer to
-- implement have no home in that schema, BY THAT SCHEMA'S OWN DESIGN:
--   - 0006_transactions_and_discounts.sql's header comment explicitly
--     excludes kitchen-workflow status columns as "a Phase 2/KDS concern".
--   - 0004_bundle_components.sql's header comment explicitly says the
--     per-order bundle fulfillment log "belongs to the transactions/KDS
--     schema in Phase 2".
-- i.e. Phase 1 deliberately deferred exactly this schema to Phase 2. This
-- migration is that deferred piece: purely additive (two new nullable-
-- with-default columns on transactions, one new table), nothing in
-- 0001-0013 is altered, dropped, or renamed.
--
-- kitchen_status: forward-only KDS state machine for an order, separate
-- from transactions.status (open/closed/voided, which tracks payment).
-- Mirrors SMFC's transactions.kitchen_status column/semantics structurally.

alter table transactions
  add column kitchen_status text not null default 'queued'
    check (kitchen_status in ('queued', 'preparing', 'ready', 'completed')),
  add column kitchen_status_updated_at timestamptz not null default now();

-- bundle_fulfillments: kitchen's per-transaction-item log of which actual
-- Oishii Maki Rolls (and how many of each) were plated into a specific
-- bundle line item (Platter/Sushi Boat), replacing proportional
-- auto-deduction for that line item only. quantity here is a piece count
-- (rolls of that flavor used), not a serving of the maki roll product.
create table bundle_fulfillments (
  id uuid primary key default gen_random_uuid(),
  transaction_item_id uuid not null references transaction_items(id) on delete cascade,
  maki_roll_product_id uuid not null references products(id) on delete restrict,
  quantity int not null check (quantity > 0),
  fulfilled_by uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index idx_bundle_fulfillments_item on bundle_fulfillments(transaction_item_id);

alter table bundle_fulfillments enable row level security;

create policy "Authenticated users can read bundle fulfillments"
  on bundle_fulfillments for select
  using (auth.role() = 'authenticated');
