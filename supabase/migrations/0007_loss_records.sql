-- loss_records: spoilage/breakage/comp/prep_error/shrinkage, logged
-- separately from normal sale-driven consumption.

create type loss_reason as enum ('spoilage', 'breakage', 'comp', 'prep_error', 'shrinkage');

create table loss_records (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients(id),
  product_id uuid references products(id),
  employee_id uuid not null references profiles(id),
  reason loss_reason not null,
  quantity numeric(12, 4) not null check (quantity > 0),
  cost_impact numeric(12, 2) not null,
  photo_url text,
  created_at timestamptz not null default now()
);

create index idx_loss_records_ingredient on loss_records(ingredient_id);
create index idx_loss_records_employee on loss_records(employee_id);
create index idx_loss_records_reason on loss_records(reason);

-- RLS ---------------------------------------------------------------------
alter table loss_records enable row level security;

create policy "Authenticated users can read loss records"
  on loss_records for select
  using (auth.role() = 'authenticated');
