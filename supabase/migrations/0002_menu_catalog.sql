-- Menu catalog: products + product_sizes.
-- One products row per distinct menu item name; one product_sizes row per
-- (product, size) — even single-size products get exactly one row, per
-- spec, so price always lives on product_sizes rather than products.

create type kitchen_station as enum (
  'sushi_bar',
  'sushi_bar_oven',
  'hot_line',
  'salad_cold_bar',
  'cafe_bar'
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  station kitchen_station not null,
  -- department is derived from station at seed time (cafe_bar -> cafe,
  -- everything else -> kitchen) and stored for cheap filtering without a
  -- join; see services/api-fastapi/scripts/seed_from_xlsx.py.
  department department_type not null,
  is_bundle boolean not null default false,
  active boolean not null default true,
  needs_station_review boolean not null default false,
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);

create index idx_products_category on products(category);
create index idx_products_department on products(department);
create index idx_products_station on products(station);

create table product_sizes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  size_label text not null,
  price numeric(10, 2) not null check (price >= 0),
  -- Documentation-only, not authoritative: ratio of this tier's recipe
  -- quantities to the product's base (smallest/first) tier, derived from
  -- the literal ingredient quantities in the source spreadsheet. 1.0 for
  -- every single-size product and for a product's base tier. recipe_items
  -- quantities are always the literal sheet values regardless of this
  -- column — see task spec.
  scale_factor numeric(10, 4) not null default 1,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (product_id, size_label)
);

create index idx_product_sizes_product on product_sizes(product_id);

-- RLS ---------------------------------------------------------------------
alter table products enable row level security;
alter table product_sizes enable row level security;

create policy "Authenticated users can read products"
  on products for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can read product sizes"
  on product_sizes for select
  using (auth.role() = 'authenticated');
