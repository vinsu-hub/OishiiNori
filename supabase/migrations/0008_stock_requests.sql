-- Stock requests: one department can ask the other for stock without
-- moving inventory immediately (deliberately not just a transfers.status
-- value — creating a transfers row is meant to represent stock actually
-- moving; a request must not touch stock until approved and converted
-- into a real transfer). Repurposed from SMFC's inter-branch version to
-- inter-department (kitchen <-> cafe), same reasoning as 0005's transfers.

create table stock_requests (
  id uuid primary key default gen_random_uuid(),
  requesting_department department_type not null,
  source_department department_type not null check (source_department <> requesting_department),
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  quantity numeric not null check (quantity > 0),
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'declined', 'cancelled')),
  requested_by uuid not null references profiles(id) on delete restrict,
  notes text,
  transfer_id uuid references transfers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_stock_requests_source on stock_requests(source_department);
create index idx_stock_requests_requesting on stock_requests(requesting_department);
create index idx_stock_requests_status on stock_requests(status);

-- RLS ---------------------------------------------------------------------
alter table stock_requests enable row level security;

create policy "Authenticated users can read stock requests"
  on stock_requests for select
  using (auth.role() = 'authenticated');
