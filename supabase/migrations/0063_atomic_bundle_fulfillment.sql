-- Additive only. No catalog/recipe/stock backfill and no guessed piece yields.
-- Configure bundle_recipe_sources only after the kitchen confirms the yield.
create table bundle_recipe_sources (
  product_id uuid primary key references products(id) on delete restrict,
  product_size_id uuid not null references product_sizes(id) on delete restrict,
  pieces_per_serving integer not null check (pieces_per_serving > 0)
);
alter table bundle_recipe_sources enable row level security;

create table bundle_fulfillment_batches (
  transaction_item_id uuid primary key references transaction_items(id) on delete restrict,
  response jsonb not null,
  restored_at timestamptz,
  created_at timestamptz not null default now()
);
alter table bundle_fulfillment_batches enable row level security;

alter table bundle_fulfillments
  add column product_size_id uuid references product_sizes(id) on delete restrict,
  add column recipe_servings numeric check (recipe_servings > 0);

create table bundle_ingredient_deductions (
  transaction_item_id uuid not null references bundle_fulfillment_batches(transaction_item_id) on delete restrict,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  ingredient_name text not null,
  unit text not null,
  quantity numeric not null check (quantity > 0),
  primary key (transaction_item_id, ingredient_id)
);
alter table bundle_ingredient_deductions enable row level security;

create function fulfill_bundle_atomic(
  p_transaction_id uuid, p_item_id uuid, p_employee_id uuid, p_lines jsonb
) returns jsonb language plpgsql set search_path = public as $$
declare
  v_item record;
  v_source record;
  v_line record;
  v_ingredient record;
  v_batch record;
  v_required numeric;
  v_total numeric;
  v_lines jsonb;
  v_resolved jsonb := '[]';
  v_deductions jsonb;
  v_response jsonb;
  v_status text;
begin
  -- Serializes fulfillment/reversal for this transaction; the item PK also
  -- prevents two batches. RPC exception rolls back ALL writes and stock.
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
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise sqlstate 'PT400' using message = 'Roll lines must be an array';
  end if;
  if jsonb_array_length(p_lines) = 0 then raise sqlstate 'PT400' using message = 'At least one roll line is required'; end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(maki_roll_product_id uuid, quantity numeric)
    where maki_roll_product_id is null or quantity is null or quantity <= 0 or quantity <> trunc(quantity)) then
    raise sqlstate 'PT400' using message = 'Roll quantities must be positive whole pieces';
  end if;
  -- Canonicalize duplicated/reordered lines for retry comparison.
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
    if v_batch.restored_at is not null then
      raise sqlstate 'PT409' using message = 'This bundle fulfillment has been reversed';
    end if;
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
      raise sqlstate 'PT400' using message = format('%s recipe units need review before bundle deduction', v_source.name);
    end if;
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.maki_roll_product_id, 'product_size_id', v_source.product_size_id,
      'quantity', v_line.quantity, 'servings', v_line.quantity / v_source.pieces_per_serving));
  end loop;

  -- Snapshot the recipe quantities once, before any mutation. Never re-read
  -- recipes during reversal: menu edits must not change what gets restored.
  select jsonb_agg(jsonb_build_object('ingredient_id', id, 'ingredient_name', name,
      'unit', base_unit, 'quantity', quantity) order by id) into v_deductions
    from (
      select i.id, i.name, i.base_unit, round(sum(r.qty_per_serving * x.servings), 4) as quantity
      from jsonb_to_recordset(v_resolved) as x(product_size_id uuid, servings numeric)
      join recipe_items r on r.product_size_id = x.product_size_id
      join ingredients i on i.id = r.ingredient_id group by i.id, i.name, i.base_unit
    ) q;
  if v_deductions is null then raise sqlstate 'PT400' using message = 'No recipe deductions could be resolved'; end if;
  v_response := jsonb_build_object('transaction_item_id', p_item_id, 'total_pieces', v_required,
    'lines', v_lines, 'ingredients_deducted', v_deductions);
  insert into bundle_fulfillment_batches(transaction_item_id, response) values (p_item_id, v_response);
  insert into bundle_fulfillments(transaction_item_id, maki_roll_product_id, quantity, fulfilled_by, product_size_id, recipe_servings)
    select p_item_id, x.product_id, x.quantity, p_employee_id, x.product_size_id, x.servings
    from jsonb_to_recordset(v_resolved) as x(product_id uuid, quantity integer, product_size_id uuid, servings numeric);
  for v_ingredient in select * from jsonb_to_recordset(v_deductions)
    as x(ingredient_id uuid, ingredient_name text, unit text, quantity numeric) order by ingredient_id loop
    update ingredients set current_stock = current_stock - v_ingredient.quantity, updated_at = now()
      where id = v_ingredient.ingredient_id;
    insert into bundle_ingredient_deductions values
      (p_item_id, v_ingredient.ingredient_id, v_ingredient.ingredient_name, v_ingredient.unit, v_ingredient.quantity);
    insert into inventory_movements(ingredient_id, type, quantity, reason, employee_id)
      values (v_ingredient.ingredient_id, 'sale_consumption', v_ingredient.quantity,
        format('Bundle fulfillment -- transaction %s item %s', p_transaction_id, p_item_id), p_employee_id);
  end loop;
  return v_response;
end;
$$;

create function restore_bundle_atomic(p_transaction_id uuid, p_item_id uuid, p_employee_id uuid)
returns boolean language plpgsql set search_path = public as $$
declare v_batch record; v_row record;
begin
  perform 1 from transactions where id = p_transaction_id for update;
  if not exists (select 1 from transaction_items where id = p_item_id and transaction_id = p_transaction_id) then
    raise sqlstate 'PT404' using message = 'Order item not found on this transaction';
  end if;
  select * into v_batch from bundle_fulfillment_batches where transaction_item_id = p_item_id for update;
  if not found then
    if exists (select 1 from bundle_fulfillments where transaction_item_id = p_item_id) then
      return false; -- Legacy rows require the API's explicit historical preflight.
    end if;
    -- Seal an unfulfilled item too. Otherwise a kitchen submission could
    -- sneak in after the refund's read and before the order is marked voided.
    insert into bundle_fulfillment_batches(transaction_item_id, response, restored_at)
      values (p_item_id, '{}'::jsonb, now());
    return true;
  end if;
  if v_batch.restored_at is not null then return true; end if;
  for v_row in select * from bundle_ingredient_deductions where transaction_item_id = p_item_id order by ingredient_id loop
    update ingredients set current_stock = current_stock + v_row.quantity, updated_at = now() where id = v_row.ingredient_id;
    insert into inventory_movements(ingredient_id, type, quantity, reason, employee_id)
      values (v_row.ingredient_id, 'sale_consumption_reversal', v_row.quantity,
        format('Bundle reversal -- transaction %s item %s', p_transaction_id, p_item_id), p_employee_id);
  end loop;
  update bundle_fulfillment_batches set restored_at = now() where transaction_item_id = p_item_id;
  return true;
end;
$$;

-- FastAPI uses the service role. Browser/anonymous callers cannot mutate stock.
revoke all on function fulfill_bundle_atomic(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function restore_bundle_atomic(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function fulfill_bundle_atomic(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function restore_bundle_atomic(uuid, uuid, uuid) to service_role;
grant all on bundle_recipe_sources, bundle_fulfillment_batches, bundle_ingredient_deductions to service_role;
