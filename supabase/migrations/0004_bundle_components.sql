-- Bundle configuration (Platters/Sushi Boats) from the "Bundles & Platters"
-- sheet. Per spec this models the bundle's CONFIG only — what catalog it
-- draws from, total pieces, and the allocation-method note. It is
-- deliberately NOT a per-order fulfillment log: the sheet is explicit that
-- allocation is not auto-proportional ("kitchen logs actual rolls used at
-- prep time"), and that logging table belongs to the transactions/KDS
-- schema in Phase 2.
--
-- One row per bundle product_size (5 rows: Small/Medium/Large Platter,
-- Small/Medium Sushi Boat — each of those products has exactly one size
-- tier in the source sheet).

create table bundle_components (
  id uuid primary key default gen_random_uuid(),
  product_size_id uuid not null unique references product_sizes(id) on delete cascade,
  draws_from text not null,
  total_pieces int not null check (total_pieces > 0),
  allocation_method text not null,
  notes text,
  created_at timestamptz not null default now()
);

-- RLS ---------------------------------------------------------------------
alter table bundle_components enable row level security;

create policy "Authenticated users can read bundle components"
  on bundle_components for select
  using (auth.role() = 'authenticated');
