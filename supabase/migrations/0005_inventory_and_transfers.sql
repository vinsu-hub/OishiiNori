-- Inventory movements and inter-department transfers.
--
-- JUDGMENT CALL: in the SMFC reference, `transfers` moves stock between
-- branches. This build has one branch, so "transfer" is repurposed to mean
-- an inter-DEPARTMENT movement (kitchen <-> cafe) using the department_type
-- enum from 0001 in place of branch_id. This is the only structural
-- adaptation available given the locked "single branch, two departments"
-- scope note, and is flagged here explicitly since the task did not spell
-- out what "transfers" should mean without branches.

create type movement_type as enum (
  'trans_in',        -- received from supplier / external
  'trans_out',       -- removed / written off / donated
  'delivery',        -- internal delivery received
  'transfer_in',     -- received from the other department (paired with transfer_out)
  'transfer_out',    -- sent to the other department (paired with transfer_in)
  'count_adjustment' -- stock-count variance (previous vs counted), logged rather than silently overwritten
);

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  type movement_type not null,
  department department_type,
  quantity numeric not null check (quantity > 0),
  reason text,
  reference_id uuid, -- links to transfers.id for transfer_in/out
  employee_id uuid not null references profiles(id) on delete restrict,
  unit_cost_snapshot numeric, -- cost at time of movement for valuation
  created_at timestamptz not null default now()
);

create index idx_inventory_movements_ingredient on inventory_movements(ingredient_id);
create index idx_inventory_movements_type on inventory_movements(type);
create index idx_inventory_movements_reference on inventory_movements(reference_id);
create index idx_inventory_movements_department on inventory_movements(department);

create table transfers (
  id uuid primary key default gen_random_uuid(),
  from_department department_type not null,
  to_department department_type not null check (to_department <> from_department),
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  quantity numeric not null check (quantity > 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'cancelled')),
  initiated_by uuid not null references profiles(id) on delete restrict,
  confirmed_by uuid references profiles(id) on delete set null,
  initiated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  notes text
);

create index idx_transfers_status on transfers(status);
create index idx_transfers_ingredient on transfers(ingredient_id);

-- RLS ---------------------------------------------------------------------
alter table inventory_movements enable row level security;
alter table transfers enable row level security;

create policy "Authenticated users can read inventory movements"
  on inventory_movements for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can read transfers"
  on transfers for select
  using (auth.role() = 'authenticated');
