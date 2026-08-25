-- Automated Station Items stock tracking. Extends the pattern that already
-- works for recipe ingredients (recipe_items -> auto-deduct on sale ->
-- inventory_movements audit trail) to stock_items, which had none of this:
-- selling a product with no recipe_items rows (every Station Item today,
-- including the Drinks products) deducted nothing from anywhere, and
-- inventory_movements/loss_records couldn't reference a stock item at all
-- (ingredient_id was NOT NULL on both).

-- stock_consumption_rules is the recipe_items equivalent for stock items --
-- two trigger shapes in one table, since most of the ~200 items (packaging/
-- supplies) don't map to a single product the way resale items do:
--   - per_product_unit: this stock item is consumed N times per unit of a
--     specific product_size sold (mirrors recipe_items' own granularity).
--   - per_transaction: this stock item is consumed N times per transaction,
--     optionally scoped to dine_in/takeout (order_type, added in 0027) and
--     optionally scaled by guest_count (also 0027) -- e.g. a takeout box.
create type stock_consumption_trigger as enum ('per_product_unit', 'per_transaction');

create table stock_consumption_rules (
  id uuid primary key default gen_random_uuid(),
  stock_item_id uuid not null references stock_items(id) on delete cascade,
  trigger_type stock_consumption_trigger not null,
  product_size_id uuid references product_sizes(id) on delete cascade,
  order_type text check (order_type in ('dine_in', 'takeout')),
  qty_per_unit numeric(12, 4) not null check (qty_per_unit > 0),
  scale_by_guest_count boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_consumption_rules_shape check (
    (trigger_type = 'per_product_unit' and product_size_id is not null and order_type is null)
    or (trigger_type = 'per_transaction' and product_size_id is null)
  )
);

create index idx_stock_consumption_rules_stock_item on stock_consumption_rules(stock_item_id);
create index idx_stock_consumption_rules_product_size on stock_consumption_rules(product_size_id);
create index idx_stock_consumption_rules_trigger on stock_consumption_rules(trigger_type);

-- Partial unique indexes (not a plain UNIQUE) since order_type is nullable
-- and plain UNIQUE treats NULLs as distinct, which would allow duplicate
-- "applies to both" per_transaction rules on the same stock item.
create unique index uq_stock_consumption_rules_per_product
  on stock_consumption_rules(stock_item_id, product_size_id)
  where trigger_type = 'per_product_unit';
create unique index uq_stock_consumption_rules_per_transaction
  on stock_consumption_rules(stock_item_id, coalesce(order_type, 'any'))
  where trigger_type = 'per_transaction';

-- Make inventory_movements polymorphic: exactly one of ingredient_id /
-- stock_item_id, so the existing Receive Shipment / Count-adjustment /
-- Variance Log machinery extends to stock items instead of being
-- duplicated by a parallel table.
alter table inventory_movements alter column ingredient_id drop not null;
alter table inventory_movements add column stock_item_id uuid references stock_items(id) on delete cascade;
alter table inventory_movements add constraint inventory_movements_exactly_one_target
  check (
    (ingredient_id is not null and stock_item_id is null)
    or (ingredient_id is null and stock_item_id is not null)
  );
create index idx_inventory_movements_stock_item on inventory_movements(stock_item_id);

-- Two new movement types specifically for sale-driven stock-item
-- consumption. This is a deliberate divergence from how recipe ingredients
-- work: _adjust_ingredients_for_size never logs recipe consumption as an
-- inventory_movements row (it only mutates ingredients.current_stock), but
-- Station Items' auto-computed "Usage" needs a summable daily trail to add
-- up, so sale-driven stock-item deductions ARE logged, unlike ingredients'.
alter type movement_type add value 'sale_consumption';
alter type movement_type add value 'sale_consumption_reversal';

-- Same polymorphic treatment for loss_records, so a loss on an unlinked
-- station item (e.g. a broken bottle of Sprite) has a home -- today
-- ingredient_id is NOT NULL and a station-item loss can't be logged at all.
alter table loss_records alter column ingredient_id drop not null;
alter table loss_records add column stock_item_id uuid references stock_items(id) on delete cascade;
alter table loss_records add constraint loss_records_exactly_one_target
  check (
    (ingredient_id is not null and stock_item_id is null)
    or (ingredient_id is null and stock_item_id is not null)
  );
create index idx_loss_records_stock_item on loss_records(stock_item_id);

-- RLS ---------------------------------------------------------------------
alter table stock_consumption_rules enable row level security;
-- No anon/authenticated policies -- same fail-closed posture as every other
-- table here (all access goes through the FastAPI service-role client).
