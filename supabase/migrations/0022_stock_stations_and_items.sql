-- Physical stock count tool: digitizes the client's 4 handwritten daily
-- station stock sheets (New Stocks / Beginning / Usage / Ending format).
-- Deliberately separate from `kitchen_station` (that enum is about where a
-- MENU ITEM is prepared; this one is about where inventory is physically
-- counted -- the two don't map onto each other) and from `department_type`
-- (kitchen/cafe is a payroll/transfer dimension, not a counting station).

create type stock_station as enum (
  'tako_snack',
  'cafe_drinks',
  'sushi_kitchen_main',
  'ramen_hot_line'
);

create table stock_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  station stock_station not null,
  category text,
  -- Free-text, not `ingredients.base_unit`'s controlled vocabulary -- this
  -- sheet's units (box, pack, bottle, roll, pc, oz cup...) are far more
  -- varied/informal than food-ingredient units. The source workbook has no
  -- unit column at all, so this is left null at seed time and filled in by
  -- a human via the catalog-management UI, never guessed.
  unit text,
  -- Nullable link to an existing recipe ingredient. Only set at seed time
  -- on an exact case-insensitive name match or a short manually-curated
  -- alias (see seed_stock_items_from_xlsx.py) -- never by fuzzy/similarity
  -- matching.
  ingredient_id uuid references ingredients(id) on delete set null,
  -- JUDGMENT CALL: this column is the running stock ONLY when
  -- ingredient_id is null. Once an item is linked, the single source of
  -- truth for its stock is ingredients.current_stock (via the same
  -- apply_ingredient_count/apply_inventory_movement code paths the
  -- existing Inventory Count/Receive Shipment features use) -- the API
  -- never writes this column for a linked item.
  current_stock numeric(12, 4) not null default 0,
  reorder_threshold numeric(12, 4),
  active boolean not null default true,
  -- Carried from the seed import's "VERIFY" column -- flags that a human
  -- has not yet confirmed this item's identity/name/mapping against staff.
  -- Cleared explicitly via PATCH once resolved. Distinct from
  -- stock_count_entries.needs_verification below, which is about a single
  -- day's typed numbers, not the catalog row itself.
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station, name)
);

create index idx_stock_items_station on stock_items(station);
create index idx_stock_items_ingredient on stock_items(ingredient_id);
create index idx_stock_items_needs_review on stock_items(needs_review);

create table stock_count_entries (
  id uuid primary key default gen_random_uuid(),
  stock_item_id uuid not null references stock_items(id) on delete cascade,
  count_date date not null default current_date,
  -- All four nullable: staff fill in whatever they physically observe that
  -- day (e.g. no delivery -> New Stocks left blank), same "leave it blank,
  -- it's simply skipped" convention as InventoryCount.tsx.
  new_stocks numeric(12, 4),
  beginning numeric(12, 4),
  usage numeric(12, 4),
  ending numeric(12, 4),
  notes text,
  -- Staff-settable per-entry "I'm not confident on this number" flag --
  -- separate from stock_items.needs_review (which is about the catalog
  -- row's identity, set once at seed time from the sheet's VERIFY column).
  needs_verification boolean not null default false,
  recorded_by uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One entry per item per day: re-submitting the same day updates the
  -- existing row (field-level merge in the router) rather than creating a
  -- duplicate history row. A new day always gets a fresh row, preserving
  -- full count history for later trend/audit use.
  unique (stock_item_id, count_date)
);

create index idx_stock_count_entries_item on stock_count_entries(stock_item_id);
create index idx_stock_count_entries_date on stock_count_entries(count_date);

-- RLS ---------------------------------------------------------------------
alter table stock_items enable row level security;
alter table stock_count_entries enable row level security;

create policy "Authenticated users can read stock items"
  on stock_items for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can read stock count entries"
  on stock_count_entries for select
  using (auth.role() = 'authenticated');
