-- Add-ons for POS transaction line items (e.g. "extra noodles", "extra
-- egg"). Mirrors menu_addons/digital_order_addons (0017) but attaches at
-- transaction_item granularity rather than order granularity -- a POS cart
-- line represents one specific dish, and an add-on is naturally per-dish
-- ("this ramen gets extra egg"), unlike digital_order_addons which only
-- attaches to the whole digital_orders row. menu_addons itself is reused
-- unchanged as the shared price list for both the digital menu and POS --
-- "not even POS Terminal has item modifiers" (0017's own words) stops
-- being true as of this migration.

create table transaction_item_addons (
  id uuid primary key default gen_random_uuid(),
  transaction_item_id uuid not null references transaction_items(id) on delete cascade,
  addon_id uuid not null references menu_addons(id) on delete restrict,
  quantity int not null check (quantity > 0),
  unit_price numeric(12, 2) not null
);

create index idx_transaction_item_addons_item on transaction_item_addons(transaction_item_id);

-- RLS ---------------------------------------------------------------------
alter table transaction_item_addons enable row level security;
-- No anon/authenticated policies -- same fail-closed posture as every other
-- table here (all access goes through the FastAPI service-role client).
