-- Flexible units of measure. Stock is still stored (and deducted by recipes)
-- in each item's base unit; an item_unit is just a named multiple of that
-- base unit -- "pack = 100 sheets", "mini sheet = 0.25 sheet", "bottle =
-- 750 ml", "tray = 30 pcs" -- so staff can log deliveries and write recipes
-- in whatever unit they actually handle, and the system converts.
create table item_units (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid references ingredients(id) on delete cascade,
  stock_item_id uuid references stock_items(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 30),
  base_qty numeric not null check (base_qty > 0),   -- base units in ONE of this unit
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  check ((ingredient_id is null) <> (stock_item_id is null))
);
create unique index item_units_ingredient_name on item_units (ingredient_id, lower(name)) where ingredient_id is not null;
create unique index item_units_stock_item_name on item_units (stock_item_id, lower(name)) where stock_item_id is not null;
alter table item_units enable row level security;

-- What the person actually typed, for the movement history ("2 pack" =
-- 200 sheets). quantity stays the base-unit amount that changed stock.
alter table inventory_movements
  add column entered_quantity numeric,
  add column entered_unit text;

-- A nori sheet is cut into 4 mini sheets for some items.
insert into item_units (ingredient_id, name, base_qty)
select id, 'mini sheet', 0.25 from ingredients where name = 'Nori sheet';
