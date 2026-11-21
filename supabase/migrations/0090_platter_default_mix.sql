-- Standard platter mix, deducted at sale; the kitchen can change it per order.
--
-- bundle_default_mix: Small Platter = California 8 + Crazy 8 + Dragon 8 +
-- Torikatsu 8, and so on. The API fulfills a platter with its mix right
-- after checkout (fulfill_bundle_with_pending_atomic, 0066), so stock moves
-- without anyone tapping "Log rolls used". A platter with no mix keeps the
-- old kitchen flow.
--
-- refulfill_bundle_atomic: the kitchen used other flavors. Put back what
-- the first mix took, forget it, and fulfill again with the real rolls, all
-- in one transaction.
--
-- auto_fulfill_bundle_atomic / unfulfill_bundle_atomic: the sale-time
-- fulfillment is flagged auto_mix. Until the kitchen confirms or changes it,
-- an order edit may undo it (stock back, rows gone) so the line can change.
--
-- bundle_pending_deductions.closed_*: a pending order an executive closed
-- without taking stock (e.g. old orders before a fresh stock count).

create table if not exists bundle_default_mix (
  product_size_id uuid not null references product_sizes(id) on delete cascade,
  -- No FK to products on purpose: with one, PostgREST sees a second
  -- product_sizes<->products path (many-to-many through this table) and
  -- every product_sizes(products(...)) embed fails as ambiguous.
  roll_product_id uuid not null,
  pieces integer not null check (pieces > 0),
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (product_size_id, roll_product_id)
);
alter table bundle_default_mix drop constraint if exists bundle_default_mix_roll_product_id_fkey;
alter table bundle_default_mix enable row level security;
grant all on bundle_default_mix to service_role;

alter table bundle_pending_deductions
  add column if not exists closed_without_deduction boolean not null default false,
  add column if not exists closed_by uuid references profiles(id) on delete set null,
  add column if not exists closed_note text;

alter table bundle_fulfillment_batches
  add column if not exists auto_mix boolean not null default false;

-- Put back what a fulfillment took and forget it. Caller holds the locks.
create or replace function bundle_unwind(p_transaction_id uuid, p_item_id uuid, p_employee_id uuid, p_reason text)
returns void language plpgsql set search_path = public as $$
declare v_row record;
begin
  for v_row in select * from bundle_ingredient_deductions where transaction_item_id = p_item_id order by ingredient_id loop
    update ingredients set current_stock = current_stock + v_row.quantity, updated_at = now() where id = v_row.ingredient_id;
    insert into inventory_movements(ingredient_id, type, quantity, reason, employee_id)
      values (v_row.ingredient_id, 'sale_consumption_reversal', v_row.quantity,
        format('%s -- transaction %s item %s', p_reason, p_transaction_id, p_item_id), p_employee_id);
  end loop;
  delete from bundle_ingredient_deductions where transaction_item_id = p_item_id;
  delete from bundle_pending_deductions where transaction_item_id = p_item_id;
  delete from bundle_fulfillments where transaction_item_id = p_item_id;
  delete from bundle_fulfillment_batches where transaction_item_id = p_item_id;
end;
$$;

-- Checkout: take the standard mix. Never touches an item already logged.
create or replace function auto_fulfill_bundle_atomic(
  p_transaction_id uuid, p_item_id uuid, p_employee_id uuid, p_lines jsonb
) returns jsonb language plpgsql set search_path = public set lock_timeout = '2s' as $$
declare v_result jsonb;
begin
  perform 1 from transactions where id = p_transaction_id for update;
  if exists (select 1 from bundle_fulfillment_batches where transaction_item_id = p_item_id)
    or exists (select 1 from bundle_fulfillments where transaction_item_id = p_item_id) then
    return null;
  end if;
  v_result := fulfill_bundle_with_pending_atomic(p_transaction_id, p_item_id, p_employee_id, p_lines);
  update bundle_fulfillment_batches set auto_mix = true where transaction_item_id = p_item_id;
  return v_result;
end;
$$;

-- Order edit: undo a sale-time mix the kitchen never confirmed.
create or replace function unfulfill_bundle_atomic(p_transaction_id uuid, p_item_id uuid, p_employee_id uuid)
returns boolean language plpgsql set search_path = public set lock_timeout = '2s' as $$
declare v_batch record;
begin
  perform 1 from transactions where id = p_transaction_id for update;
  select * into v_batch from bundle_fulfillment_batches where transaction_item_id = p_item_id for update;
  if not found or not v_batch.auto_mix or v_batch.restored_at is not null then return false; end if;
  perform bundle_unwind(p_transaction_id, p_item_id, p_employee_id, 'Platter order edited');
  return true;
end;
$$;

create or replace function refulfill_bundle_atomic(
  p_transaction_id uuid, p_item_id uuid, p_employee_id uuid, p_lines jsonb
) returns jsonb language plpgsql set search_path = public set lock_timeout = '2s' as $$
declare
  v_status text;
  v_batch record;
  v_lines jsonb;
begin
  select status::text into v_status from transactions where id = p_transaction_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Order not found'; end if;
  if v_status = 'voided' then raise sqlstate 'PT409' using message = 'Cannot change a voided order'; end if;
  if not exists (select 1 from transaction_items where id = p_item_id and transaction_id = p_transaction_id) then
    raise sqlstate 'PT404' using message = 'Order item not found on this transaction';
  end if;

  select * into v_batch from bundle_fulfillment_batches where transaction_item_id = p_item_id for update;
  if not found then
    return fulfill_bundle_with_pending_atomic(p_transaction_id, p_item_id, p_employee_id, p_lines);
  end if;
  if v_batch.restored_at is not null then
    raise sqlstate 'PT409' using message = 'This bundle fulfillment has been reversed';
  end if;

  -- Same rolls as before: nothing to do.
  select jsonb_agg(jsonb_build_object('maki_roll_product_id', product_id, 'quantity', quantity) order by product_id)
    into v_lines from (
      select maki_roll_product_id as product_id, sum(quantity) as quantity
      from jsonb_to_recordset(p_lines) as x(maki_roll_product_id uuid, quantity numeric)
      group by maki_roll_product_id
    ) q;
  if v_batch.response->'lines' = v_lines then
    update bundle_fulfillment_batches set auto_mix = false where transaction_item_id = p_item_id;
    return v_batch.response || jsonb_build_object('stock_deduction_status',
      coalesce(v_batch.response->>'stock_deduction_status', 'applied'));
  end if;

  perform bundle_unwind(p_transaction_id, p_item_id, p_employee_id, 'Platter mix changed');

  -- Any error in here rolls the restore back too.
  return fulfill_bundle_with_pending_atomic(p_transaction_id, p_item_id, p_employee_id, p_lines);
end;
$$;

revoke all on function bundle_unwind(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function auto_fulfill_bundle_atomic(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function unfulfill_bundle_atomic(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function refulfill_bundle_atomic(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function auto_fulfill_bundle_atomic(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function unfulfill_bundle_atomic(uuid, uuid, uuid) to service_role;
grant execute on function refulfill_bundle_atomic(uuid, uuid, uuid, jsonb) to service_role;
