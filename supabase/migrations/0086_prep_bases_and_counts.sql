-- Prep bases (batch recipes) and "counted since the reset".
--
-- A prep base is an ingredient the kitchen makes in batches from other
-- ingredients -- Milk tea base, Mousse, Hot Mayo. Menu recipes keep pointing
-- at the base (sales deduct the base only); prep_recipe_items says what one
-- batch takes, and ingredients.prep_yield how much one batch makes, so the
-- base's unit_cost = sum(component qty * component unit_cost) / prep_yield.

alter table ingredients add column if not exists prep_yield numeric(12, 4) check (prep_yield is null or prep_yield > 0);

create table if not exists prep_recipe_items (
  id uuid primary key default gen_random_uuid(),
  base_ingredient_id uuid not null references ingredients(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  -- in the component's own base unit (g, ml, pcs ...)
  qty numeric(12, 4) not null check (qty > 0),
  -- what the person typed it in (kg, pack, can ...), for display only
  unit text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (base_ingredient_id, ingredient_id),
  check (base_ingredient_id <> ingredient_id)
);

create index if not exists idx_prep_recipe_items_ingredient on prep_recipe_items (ingredient_id);

alter table prep_recipe_items enable row level security;

-- When the stock was last physically counted. A stock reset clears it;
-- an ingredient that hasn't been counted since doesn't raise low-stock
-- alerts or mark menu items out of stock.
alter table ingredients add column if not exists last_counted_at timestamptz;

-- Existing real stock counts the app already trusted keep alerting as before.
update ingredients set last_counted_at = now()
where last_counted_at is null and current_stock < 9000000;

-- Batch-recomputed costs get their own source in the price history.
alter table ingredient_cost_log drop constraint if exists ingredient_cost_log_source_check;
alter table ingredient_cost_log add constraint ingredient_cost_log_source_check
  check (source in ('manual', 'delivery', 'import', 'batch'));
