-- Sushi Boat deposits on POS sales (2026-11-11).
-- 0072 tracked deposits for online orders only, so staff rang "Deposit boat"
-- / "Deposit large boat" as menu items: counted as sales, shown on the
-- online menu, and never tracked back. A takeout/delivery boat charged on
-- the POS now gets its deposit rows here, tied to the transaction instead
-- of a digital order.

alter table sushi_boat_deposits
  alter column digital_order_id drop not null,
  alter column digital_order_item_id drop not null,
  add column if not exists transaction_id uuid references transactions(id) on delete restrict,
  add column if not exists transaction_item_id uuid references transaction_items(id) on delete restrict;

alter table sushi_boat_deposits
  drop constraint if exists sushi_boat_deposits_one_source;
alter table sushi_boat_deposits
  add constraint sushi_boat_deposits_one_source check (
    (digital_order_id is not null and digital_order_item_id is not null
      and transaction_id is null and transaction_item_id is null)
    or (digital_order_id is null and digital_order_item_id is null
      and transaction_id is not null and transaction_item_id is not null)
  );

create unique index if not exists uq_sushi_boat_deposits_pos_unit
  on sushi_boat_deposits (transaction_item_id, unit_number)
  where transaction_item_id is not null;

create index if not exists idx_sushi_boat_deposits_transaction
  on sushi_boat_deposits (transaction_id)
  where transaction_id is not null;

-- Retire the workaround items. Past sales of them stay in history.
update products
set active = false
where name ilike 'deposit%boat%'
  and not is_bundle;
