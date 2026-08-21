-- Ingredients (bill-of-materials source of truth, ~72 rows from the
-- "Ingredient Master" sheet) and recipe_items (the BOM link from a
-- product_sizes row to N ingredients in given quantities).

create table ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text,
  base_unit text not null,
  suggested_reorder_unit text,
  -- Raw string exactly as it appears in the "Cost Volatility" column
  -- (e.g. "High — daily price check", "Medium–High", "Low–Medium
  -- (protein bones)") — preserved verbatim per spec.
  cost_volatility text,
  -- Normalized 5-bucket tier derived from cost_volatility for filtering/
  -- sorting. JUDGMENT CALL: the sheet uses compound values like
  -- "Low–Medium" and "Medium–High" that don't collapse cleanly to a
  -- single low/medium/high tier, so this uses 5 buckets that mirror the
  -- exact distinct raw-value families found in the sheet rather than
  -- forcing a 3-way split.
  cost_volatility_tier text check (cost_volatility_tier in ('low', 'low_medium', 'medium', 'medium_high', 'high')),
  shelf_life_note text,
  used_in_note text,
  current_stock numeric(12, 4) not null default 0,
  reorder_threshold numeric(12, 4) not null default 0,
  -- Not sourced from the sheet (Ingredient Master has no "Needs Review"
  -- column, unlike Menu & Recipes) — infrastructure flag for ingredients
  -- discovered only via recipe cross-reference with no clean catalog
  -- match (see seed script's alias map; e.g. "Water"). Defaults false and
  -- is set true explicitly by the seed script only where warranted.
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_ingredients_category on ingredients(category);
create index idx_ingredients_volatility_tier on ingredients(cost_volatility_tier);

create table recipe_items (
  id uuid primary key default gen_random_uuid(),
  product_size_id uuid not null references product_sizes(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  qty_per_serving numeric(12, 4) not null check (qty_per_serving > 0),
  unit text not null,
  prep_notes text,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  unique (product_size_id, ingredient_id)
);

create index idx_recipe_items_product_size on recipe_items(product_size_id);
create index idx_recipe_items_ingredient on recipe_items(ingredient_id);
create index idx_recipe_items_needs_review on recipe_items(needs_review);

-- RLS ---------------------------------------------------------------------
alter table ingredients enable row level security;
alter table recipe_items enable row level security;

create policy "Authenticated users can read ingredients"
  on ingredients for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can read recipe items"
  on recipe_items for select
  using (auth.role() = 'authenticated');
