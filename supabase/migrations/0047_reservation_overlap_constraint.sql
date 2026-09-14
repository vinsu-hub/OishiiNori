-- Fixes a real TOCTOU race in place_reservation (reservations.py): it reads
-- other reservations on the target table, checks overlap in Python, then
-- updates -- with no database-level backstop. Two cashiers placing
-- overlapping reservations onto the same table at nearly the same instant
-- could both pass the Python check before either commits.
--
-- This adds a hard, timing-independent guarantee at the database layer: no
-- two placed (table_id set), still-holding (pending/confirmed) reservations
-- can ever overlap on the same table, regardless of what the application
-- code's timing allows. place_reservation should catch the resulting
-- exclusion-violation (SQLSTATE 23P01) and surface the same 409 it already
-- returns for the Python-checked case.

create extension if not exists btree_gist;

alter table reservations
  add constraint reservations_no_table_overlap
  exclude using gist (
    table_id with =,
    tsrange(
      (reservation_date + start_time)::timestamp,
      (reservation_date + end_time)::timestamp
    ) with &&
  )
  where (table_id is not null and status in ('pending', 'confirmed'));
