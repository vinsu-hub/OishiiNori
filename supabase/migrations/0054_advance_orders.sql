-- Advance orders: a delivery/pickup digital order can carry the time the
-- customer wants it (ready/delivered). Null = "as soon as possible" (every
-- existing order). Staff see the time in Scheduled Orders (and the Online
-- Orders / Delivery queues) and can approve any time; an approved advance
-- order is held out of the kitchen until 20 minutes before scheduled_for.

alter table digital_orders add column scheduled_for timestamptz;

-- Set atomically (single conditional UPDATE) by whichever poller releases an
-- approved advance order into the kitchen 20 min before scheduled_for, so two
-- concurrent pollers can never create two transactions for one order.
alter table digital_orders add column kitchen_fired_at timestamptz;
