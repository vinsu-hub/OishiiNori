-- Change counter for the live order lists (Supabase egress/log budget).
-- The kitchen, cashier and TV screens poll the same order lists all day. The
-- API re-downloads a list only when this counter has moved since its cached
-- copy was built; any write to a table the lists read bumps it. Checking it
-- costs one ~100-byte request instead of a full list download.

create table if not exists live_version (
  id smallint primary key default 1 check (id = 1),
  version bigint not null default 0
);
insert into live_version (id, version) values (1, 0) on conflict (id) do nothing;
alter table live_version enable row level security;
grant select on live_version to service_role;

create or replace function bump_live_version() returns trigger
language plpgsql as $$
begin
  update live_version set version = version + 1 where id = 1;
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'transactions', 'transaction_items', 'transaction_item_addons', 'deliveries',
    'digital_orders', 'pos_hanged_orders',
    'bundle_fulfillments', 'bundle_fulfillment_batches', 'bundle_pending_deductions',
    'product_sizes', 'bundle_components'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on %I', t || '_bump_live_version', t);
      execute format(
        'create trigger %I after insert or update or delete on %I '
        'for each statement execute function bump_live_version()',
        t || '_bump_live_version', t);
    end if;
  end loop;
end;
$$;
