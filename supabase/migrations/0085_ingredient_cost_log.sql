-- Price history for ingredient unit costs. ingredients.unit_cost stays the
-- one number recipes and P&L use (latest price paid); this keeps what was
-- actually paid each time -- "P1050 for 1 box (2000 g)" -- who entered it,
-- and where it came from, so a price change leaves a trail.

create table ingredient_cost_log (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  unit_cost numeric(12, 4) not null check (unit_cost >= 0),
  previous_unit_cost numeric(12, 4),
  price_paid numeric(12, 2) check (price_paid >= 0),
  qty numeric(12, 3) check (qty > 0),
  unit_name text,
  -- base units in ONE unit_name, so price_paid / (qty * base_qty) = unit_cost
  base_qty numeric(14, 4) check (base_qty > 0),
  source text not null default 'manual' check (source in ('manual', 'delivery', 'import')),
  note text,
  changed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_ingredient_cost_log_ingredient on ingredient_cost_log (ingredient_id, created_at desc);

-- Fail-closed, same posture as every other table here: all access goes
-- through the FastAPI service-role client.
alter table ingredient_cost_log enable row level security;
