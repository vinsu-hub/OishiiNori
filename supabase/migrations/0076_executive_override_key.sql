-- Executive override key and permanent order erase.
-- Each executive sets their own override key (bcrypt hash, set through
-- POST /profiles/me/override-key). With it they can permanently erase an
-- order from the dashboard (POST /transactions/{id}/erase). The API returns
-- the order's stock first, then calls erase_transaction.

alter table profiles add column if not exists override_key_hash text;

create or replace function erase_transaction(p_id uuid) returns void
language plpgsql as $$
declare
  v_item_ids uuid[];
begin
  perform 1 from transactions where id = p_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  -- Money records: never erased along with the order.
  if exists (select 1 from refunds where transaction_id = p_id) then
    raise exception 'This order has a refund record; it cannot be erased' using errcode = 'P0001';
  end if;
  if exists (select 1 from shift_cash_movements where transaction_id = p_id) then
    raise exception 'This order has a cash refund payout; it cannot be erased' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(id), '{}') into v_item_ids from transaction_items where transaction_id = p_id;
  -- Kitchen bundle bookkeeping (restrict FKs) goes before the items cascade.
  delete from bundle_pending_deductions where transaction_item_id = any(v_item_ids);
  delete from bundle_ingredient_deductions where transaction_item_id = any(v_item_ids);
  delete from bundle_fulfillment_batches where transaction_item_id = any(v_item_ids);
  delete from pos_hanged_orders where transaction_id = p_id;
  -- Cascades: transaction_items (+ addons, bundle_fulfillments), deliveries.
  -- Set null: digital_orders, reservations, reservation_overrides, related orders.
  delete from transactions where id = p_id;
end;
$$;

revoke all on function erase_transaction(uuid) from public, anon, authenticated;
grant execute on function erase_transaction(uuid) to service_role;
