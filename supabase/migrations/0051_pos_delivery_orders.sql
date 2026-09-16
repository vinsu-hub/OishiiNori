-- Adds a third POS order_type, "delivery", for walk-in customers who want
-- their order delivered rather than dined-in or carried out themselves.
-- Behaves like "takeout" everywhere order_type is branched on today (no
-- table, no reservation checks -- those all key off `= 'dine_in'`), but
-- carries the same customer/address/barangay capture the digital-menu
-- delivery flow already has, via the *existing* `deliveries` table --
-- not a second, parallel one.
--
-- `deliveries.digital_order_id` was `not null unique` (0038) since every
-- delivery used to originate from a QR order. It's widened to an
-- exactly-one-of pair with a new `transaction_id`, mirroring this
-- project's existing polymorphic-FK convention (e.g.
-- inventory_movements.ingredient_id/stock_item_id), so the same table --
-- and the same rider dispatch queue reading it -- serves both origins.

alter table transactions
  drop constraint transactions_order_type_check,
  add constraint transactions_order_type_check
    check (order_type in ('dine_in', 'takeout', 'delivery'));

alter table deliveries
  alter column digital_order_id drop not null,
  add column transaction_id uuid references transactions(id) on delete cascade;

alter table deliveries
  add constraint deliveries_exactly_one_source
    check ((digital_order_id is not null)::int + (transaction_id is not null)::int = 1);

create unique index deliveries_transaction_id_key
  on deliveries (transaction_id)
  where transaction_id is not null;

create index idx_deliveries_transaction_id on deliveries (transaction_id);
