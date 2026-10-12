-- Snapshot the single discounted product unit on a POS transaction item.
-- Historical order-level discounts remain on transactions unchanged.
alter table transaction_items
  add column if not exists discount_type_id uuid references discount_types(id) on delete set null,
  add column if not exists discount_name text,
  add column if not exists discount_percentage numeric(5, 2),
  add column if not exists discount_vat_exempt boolean not null default false,
  add column if not exists discount_amount numeric(12, 2) not null default 0;

-- An earlier manual run may have added only some columns. Finish defaults and
-- constraints as well as filling the missing columns, without changing sales.
alter table transaction_items
  alter column discount_vat_exempt set default false,
  alter column discount_amount set default 0;
update transaction_items set discount_vat_exempt = false where discount_vat_exempt is null;
update transaction_items set discount_amount = 0 where discount_amount is null;
alter table transaction_items
  alter column discount_vat_exempt set not null,
  alter column discount_amount set not null;
