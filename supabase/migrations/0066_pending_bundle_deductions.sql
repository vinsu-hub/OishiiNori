-- Additive, opt-in path for logging actual platter rolls when a saved recipe
-- uses a different unit from its ingredient stock. Existing orders, batches,
-- fulfill_bundle_atomic, and restore_bundle_atomic remain untouched.
create table bundle_pending_deductions (
  transaction_item_id uuid primary key references bundle_fulfillment_batches(transaction_item_id) on delete restrict,
  reason text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table bundle_pending_deductions enable row level security;
grant all on bundle_pending_deductions to service_role;

create function fulfill_bundle_with_pending_atomic(
  p_transaction_id uuid, p_item_id uuid, p_employee_id uuid, p_lines jsonb
) returns jsonb language plpgsql set search_path = public set lock_timeout = '2s' as $$
declare
  v_error text;
  v_result jsonb;
  v_item record;
  v_source record;
  v_line record;
  v_batch record;
  v_status text;
  v_required numeric;
  v_total numeric;
  v_lines jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_mismatches text[] := '{}';
begin
  -- The established RPC remains the source of truth when recipes are valid.
  -- Its exception subtransaction rolls back before we consider record-only.
  begin
    v_result := fulfill_bundle_atomic(p_transaction_id, p_item_id, p_employee_id, p_lines);
    return v_result || jsonb_build_object('stock_deduction_status',
      coalesce(v_result->>'stock_deduction_status', 'applied'));
  exception when sqlstate 'PT400' then
    get stacked diagnostics v_error = message_text;
    if v_error not like '% recipe units need review before bundle deduction' then raise; end if;
  end;

  -- Revalidate every rule other than recipe unit equality. A different
  -- invalid line must not hide behind the first unit-mismatch error.
  select status::text into v_status from transactions where id = p_transaction_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Order not found'; end if;
  if v_status = 'voided' then raise sqlstate 'PT409' using message = 'Cannot fulfill a voided order'; end if;
  select ti.quantity, bc.total_pieces, p.name, p.is_bundle into v_item
    from transaction_items ti join product_sizes ps on ps.id = ti.product_size_id
    join products p on p.id = ps.product_id
    left join bundle_components bc on bc.product_size_id = ps.id
    where ti.id = p_item_id and ti.transaction_id = p_transaction_id for update of ti;
  if not found then raise sqlstate 'PT404' using message = 'Order item not found on this transaction'; end if;
  if not v_item.is_bundle or v_item.total_pieces is null then
    raise sqlstate 'PT400' using message = 'This item has no bundle configuration';
  end if;
  v_required := v_item.quantity * v_item.total_pieces;
  if v_required <> trunc(v_required) then
    raise sqlstate 'PT400' using message = 'Bundle quantity must represent whole pieces';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise sqlstate 'PT400' using message = 'Roll lines must be a nonempty array';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(maki_roll_product_id uuid, quantity numeric)
    where maki_roll_product_id is null or quantity is null or quantity <= 0 or quantity <> trunc(quantity)) then
    raise sqlstate 'PT400' using message = 'Roll quantities must be positive whole pieces';
  end if;
  select jsonb_agg(jsonb_build_object('maki_roll_product_id', product_id, 'quantity', quantity) order by product_id), sum(quantity)
    into v_lines, v_total from (
      select maki_roll_product_id as product_id, sum(quantity) as quantity
      from jsonb_to_recordset(p_lines) as x(maki_roll_product_id uuid, quantity numeric)
      group by maki_roll_product_id
    ) q;
  if v_total <> v_required then
    raise sqlstate 'PT400' using message = format('Submitted pieces total %s; expected %s', v_total, v_required);
  end if;
  select * into v_batch from bundle_fulfillment_batches where transaction_item_id = p_item_id;
  if found then
    if v_batch.restored_at is not null then raise sqlstate 'PT409' using message = 'This bundle fulfillment has been reversed'; end if;
    if v_batch.response->'lines' = v_lines then return v_batch.response; end if;
    raise sqlstate 'PT409' using message = 'This bundle was fulfilled with a different selection; refresh the order';
  end if;
  if exists (select 1 from bundle_fulfillments where transaction_item_id = p_item_id) then
    raise sqlstate 'PT409' using message = 'Existing legacy fulfillment needs manager review before retrying';
  end if;

  for v_line in select * from jsonb_to_recordset(v_lines) as x(maki_roll_product_id uuid, quantity numeric) loop
    select p.name, p.active, p.is_bundle, p.category, s.product_size_id, s.pieces_per_serving,
      ps.product_id as size_product_id into v_source
      from products p left join bundle_recipe_sources s on s.product_id = p.id
      left join product_sizes ps on ps.id = s.product_size_id
      where p.id = v_line.maki_roll_product_id;
    if not found then raise sqlstate 'PT404' using message = 'Roll product not found'; end if;
    if not v_source.active or v_source.is_bundle or v_source.category <> 'Oishii Maki Rolls'
      or (v_item.name like '%Sushi Boat%' and v_source.name in ('Dragon Maki', 'Oishii Maki')) then
      raise sqlstate 'PT400' using message = format('%s is not eligible for this bundle', v_source.name);
    end if;
    if v_source.product_size_id is null or v_source.size_product_id <> v_line.maki_roll_product_id then
      raise sqlstate 'PT400' using message = format('%s needs a confirmed bundle recipe size and piece yield in Menu Editing', v_source.name);
    end if;
    if not exists (select 1 from recipe_items where product_size_id = v_source.product_size_id) then
      raise sqlstate 'PT400' using message = format('%s has no recipe for its configured bundle size', v_source.name);
    end if;
    perform 1 from recipe_items where product_size_id = v_source.product_size_id for share;
    if exists (select 1 from recipe_items r join ingredients i on i.id = r.ingredient_id
      where r.product_size_id = v_source.product_size_id and r.unit <> i.base_unit) then
      v_mismatches := array_append(v_mismatches, v_source.name);
    end if;
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.maki_roll_product_id, 'product_size_id', v_source.product_size_id,
      'quantity', v_line.quantity, 'servings', v_line.quantity / v_source.pieces_per_serving));
  end loop;
  -- A correction could have landed between the strict attempt and this
  -- locked validation. In that case perform the normal atomic deduction.
  if cardinality(v_mismatches) = 0 then
    v_result := fulfill_bundle_atomic(p_transaction_id, p_item_id, p_employee_id, p_lines);
    return v_result || jsonb_build_object('stock_deduction_status', 'applied');
  end if;

  v_result := jsonb_build_object('transaction_item_id', p_item_id, 'total_pieces', v_required,
    'lines', v_lines, 'ingredients_deducted', '[]'::jsonb, 'stock_deduction_status', 'pending_recipe');
  insert into bundle_fulfillment_batches(transaction_item_id, response) values (p_item_id, v_result);
  insert into bundle_fulfillments(transaction_item_id, maki_roll_product_id, quantity, fulfilled_by, product_size_id, recipe_servings)
    select p_item_id, x.product_id, x.quantity, p_employee_id, x.product_size_id, x.servings
    from jsonb_to_recordset(v_resolved) as x(product_id uuid, quantity integer, product_size_id uuid, servings numeric);
  insert into bundle_pending_deductions(transaction_item_id, reason)
    values (p_item_id, 'Recipe units need review: ' || array_to_string(v_mismatches, ', '));
  return v_result;
end;
$$;

create function reconcile_pending_bundle_atomic(p_item_id uuid, p_employee_id uuid)
returns boolean language plpgsql set search_path = public set lock_timeout = '2s' as $$
declare
  v_transaction_id uuid;
  v_status text;
  v_batch record;
  v_pending record;
  v_line record;
  v_ingredient record;
  v_deductions jsonb;
begin
  select transaction_id into v_transaction_id from transaction_items where id = p_item_id;
  if not found then return false; end if;
  select status::text into v_status from transactions where id = v_transaction_id for update;
  select * into v_batch from bundle_fulfillment_batches where transaction_item_id = p_item_id for update;
  select * into v_pending from bundle_pending_deductions where transaction_item_id = p_item_id for update;
  if not found or v_pending.resolved_at is not null or v_batch.restored_at is not null or v_status = 'voided' then
    return false;
  end if;
  for v_line in select * from bundle_fulfillments where transaction_item_id = p_item_id loop
    if v_line.product_size_id is null or v_line.recipe_servings is null
      or not exists (select 1 from recipe_items where product_size_id = v_line.product_size_id)
      or exists (select 1 from recipe_items r join ingredients i on i.id = r.ingredient_id
        where r.product_size_id = v_line.product_size_id and r.unit <> i.base_unit) then
      return false;
    end if;
    perform 1 from recipe_items where product_size_id = v_line.product_size_id for share;
  end loop;
  select jsonb_agg(jsonb_build_object('ingredient_id', id, 'ingredient_name', name,
      'unit', base_unit, 'quantity', quantity) order by id) into v_deductions
    from (
      select i.id, i.name, i.base_unit, round(sum(r.qty_per_serving * f.recipe_servings), 4) as quantity
      from bundle_fulfillments f join recipe_items r on r.product_size_id = f.product_size_id
      join ingredients i on i.id = r.ingredient_id
      where f.transaction_item_id = p_item_id group by i.id, i.name, i.base_unit
    ) q;
  if v_deductions is null then return false; end if;
  for v_ingredient in select * from jsonb_to_recordset(v_deductions)
    as x(ingredient_id uuid, ingredient_name text, unit text, quantity numeric) order by ingredient_id loop
    update ingredients set current_stock = current_stock - v_ingredient.quantity, updated_at = now()
      where id = v_ingredient.ingredient_id;
    insert into bundle_ingredient_deductions values
      (p_item_id, v_ingredient.ingredient_id, v_ingredient.ingredient_name, v_ingredient.unit, v_ingredient.quantity);
    insert into inventory_movements(ingredient_id, type, quantity, reason, employee_id)
      values (v_ingredient.ingredient_id, 'sale_consumption', v_ingredient.quantity,
        format('Deferred bundle deduction -- transaction %s item %s', v_transaction_id, p_item_id), p_employee_id);
  end loop;
  update bundle_pending_deductions set resolved_at = now() where transaction_item_id = p_item_id;
  update bundle_fulfillment_batches set response = response || jsonb_build_object(
    'stock_deduction_status', 'applied', 'ingredients_deducted', v_deductions)
    where transaction_item_id = p_item_id;
  return true;
end;
$$;

create function publish_bundle_recipe_atomic(p_size_id uuid, p_rows jsonb)
returns integer language plpgsql set search_path = public set lock_timeout = '2s' as $$
declare
  v_size record;
  v_row record;
  v_count integer;
begin
  select ps.id, p.category, p.is_bundle into v_size from product_sizes ps
    join products p on p.id = ps.product_id where ps.id = p_size_id for update of ps;
  if not found then raise sqlstate 'PT404' using message = 'Product size not found'; end if;
  if v_size.category <> 'Oishii Maki Rolls' or v_size.is_bundle then
    raise sqlstate 'PT400' using message = 'Atomic recipe publishing is for maki rolls only';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise sqlstate 'PT400' using message = 'A published roll recipe needs at least one ingredient';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_rows) as x(ingredient_id uuid, qty_per_serving numeric, unit text)
      left join ingredients i on i.id = x.ingredient_id
      where x.ingredient_id is null or i.id is null or x.qty_per_serving is null or x.qty_per_serving <= 0
        or x.unit is distinct from i.base_unit) then
    raise sqlstate 'PT400' using message = 'Every recipe quantity must be confirmed in its ingredient stock base unit';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_rows) as x(ingredient_id uuid)
      group by ingredient_id having count(*) > 1) then
    raise sqlstate 'PT400' using message = 'Duplicate ingredients are not allowed in a recipe';
  end if;
  delete from recipe_items where product_size_id = p_size_id and ingredient_id not in
    (select ingredient_id from jsonb_to_recordset(p_rows) as x(ingredient_id uuid));
  for v_row in select * from jsonb_to_recordset(p_rows)
    as x(ingredient_id uuid, qty_per_serving numeric, unit text, prep_notes text) loop
    insert into recipe_items(product_size_id, ingredient_id, qty_per_serving, unit, prep_notes)
      values (p_size_id, v_row.ingredient_id, v_row.qty_per_serving, v_row.unit, v_row.prep_notes)
      on conflict (product_size_id, ingredient_id) do update set
        qty_per_serving = excluded.qty_per_serving, unit = excluded.unit, prep_notes = excluded.prep_notes;
  end loop;
  select count(*) into v_count from recipe_items where product_size_id = p_size_id;
  return v_count;
end;
$$;

revoke all on function fulfill_bundle_with_pending_atomic(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function reconcile_pending_bundle_atomic(uuid,uuid) from public, anon, authenticated;
revoke all on function publish_bundle_recipe_atomic(uuid,jsonb) from public, anon, authenticated;
grant execute on function fulfill_bundle_with_pending_atomic(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function reconcile_pending_bundle_atomic(uuid,uuid) to service_role;
grant execute on function publish_bundle_recipe_atomic(uuid,jsonb) to service_role;
