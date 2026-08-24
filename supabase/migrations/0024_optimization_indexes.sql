-- Performance: 4 missing indexes on the primary filter/sort column of
-- tables that grow unbounded over the life of the restaurant and are
-- queried on nearly every poll cycle (Order Queue, Kitchen Display,
-- Pending Orders, Trend Analysis, Command Center, P&L, Oishii AI). Found
-- via a direct survey of every router's actual filter/sort usage against
-- every existing index in supabase/migrations/*.sql -- see
-- OPTIMIZATION_PLAN.md item 2 for the full research this is based on.
--
-- transactions/inventory_movements/loss_records already have indexes on
-- their id-lookup columns (employee_id, ingredient_id, type, reason, etc)
-- from earlier migrations -- this adds the one column each was missing:
-- the timestamp every list/range query actually filters or sorts by.

create index if not exists idx_transactions_opened_at on transactions (opened_at);
create index if not exists idx_inventory_movements_created_at on inventory_movements (created_at);
create index if not exists idx_loss_records_created_at on loss_records (created_at);
create index if not exists idx_digital_orders_created_at on digital_orders (created_at);
