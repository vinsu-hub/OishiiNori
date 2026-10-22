-- "Print kitchen ticket" on Online Orders: the counter asks for a copy of a
-- ticket, and the kitchen tablet (the only device paired with the kitchen
-- printer) prints it on its next Kitchen Display poll. The tablet remembers
-- which request it printed, so each tap prints once. Kitchen status is not
-- touched.
alter table transactions add column if not exists kitchen_reprint_requested_at timestamptz;
