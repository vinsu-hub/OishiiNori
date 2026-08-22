-- Most-recent-cost tracking for ingredients: set whenever a delivery/
-- trans_in movement is logged with a unit_cost_snapshot (see
-- inventory_movements.py). No historical/weighted costing -- just the
-- last known cost, which is enough to unblock valuation and food-cost
-- questions that previously had no cost data to work from at all.
alter table ingredients add column unit_cost numeric;

-- Advisory expiry tracking, batch-level only (this schema has no per-lot
-- remaining-quantity tracking, only a running current_stock total) -- set
-- on receiving, used to flag "most recent delivery of this ingredient
-- expires soon", not to enforce FIFO consumption.
alter table inventory_movements add column expiry_date date;
