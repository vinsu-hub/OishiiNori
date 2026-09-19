-- Advance orders: a delivery/pickup digital order can carry the time the
-- customer wants it (ready/delivered). Null = "as soon as possible" (every
-- existing order). Staff see the time in the Online Orders / Delivery queues
-- and approve when it's time to start cooking, so nothing else about the
-- approval -> kitchen flow changes.

alter table digital_orders add column scheduled_for timestamptz;
