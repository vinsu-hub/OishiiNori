-- Visual floor plan for the Reservations module. The tables registry (0025)
-- is a flat list with no spatial data; the floor-plan view needs to draw each
-- table as a positioned shape grouped by room zone, colour-coded by live
-- state. Live state is derived client-side from transactions + reservations
-- (no column here) -- only the static layout is stored.
--
-- capacity stays the existing hard number and remains the field the
-- reservations availability engine filters on (_fetch_capacity_candidates).
-- capacity_min/capacity_max add a flexible range for bench seating; the
-- editor keeps capacity in sync with capacity_max.

alter table tables
  add column pos_x numeric,                          -- 0..1000 canvas units, null until placed
  add column pos_y numeric,                          -- 0..700 canvas units
  add column shape text not null default 'square'
    check (shape in ('square', 'rectangle', 'round')),
  add column width numeric not null default 80,
  add column height numeric not null default 80,
  add column floor_group text not null default 'Main Dining',
  add column capacity_min int check (capacity_min > 0),
  add column capacity_max int check (capacity_max > 0),
  -- true until a manager positions/verifies the table on-site via the editor;
  -- the backfill below flags every existing row.
  add column needs_layout_review boolean not null default false;

-- Backfill: seed a capacity range (fixed-chair = single value), flag every
-- row for on-site review, and grid-arrange positions so the canvas isn't
-- empty on first load. floor_group stays at the 'Main Dining' default -- the
-- manager reassigns Booth Row rows in the editor.
with ordered as (
  select id, row_number() over (order by label) - 1 as rn
  from tables
)
update tables t set
  capacity_min = coalesce(t.capacity_min, t.capacity),
  capacity_max = coalesce(t.capacity_max, t.capacity),
  needs_layout_review = true,
  pos_x = 120 + 180 * (ordered.rn % 5),
  pos_y = 120 + 160 * (ordered.rn / 5)
from ordered
where t.id = ordered.id
  and t.pos_x is null;
