-- QA fix: inventory_movements.reference_id had no FK constraint.
--
-- 0005_inventory_and_transfers.sql's inventory_movements.reference_id
-- column comment says "links to transfers.id for transfer_in/out" but the
-- column was left as a bare `uuid` with no foreign key -- confirmed via
-- pg_constraint (only employee_id/ingredient_id FKs exist on that table).
-- This migration adds the missing FK.
--
-- NOTE: named 0015 (not 0014, per the original QA task text) because
-- 0014_phase2_order_fulfillment.sql already exists and is applied live --
-- migration numbers are append-only, not editable.
--
-- reference_id is only populated for transfer_in/transfer_out rows and is
-- NULL for every other movement type (trans_in, trans_out, delivery,
-- count_adjustment), so the FK must allow NULL. ON DELETE SET NULL is used
-- (rather than CASCADE) because a transfer being deleted should not delete
-- the historical inventory_movements audit trail it produced -- it should
-- just detach the now-dangling reference.
alter table inventory_movements
  add constraint inventory_movements_reference_id_fkey
  foreign key (reference_id) references transfers(id) on delete set null;
