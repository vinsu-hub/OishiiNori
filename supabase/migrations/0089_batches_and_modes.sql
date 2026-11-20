-- Linked batches, smarter counts and Sir Joe's item page (2026-11-20).
--
-- 1. deduct_mode on a prep base: 'batch' (staff press "Made a batch"; a sale
--    takes the base) or 'auto' (a sale takes the base's components straight
--    away, down the chain -- for small preps nobody logs, like Kikoman mix).
-- 2. prep_batches: one row per "Made a batch" (by hand or spotted at the EOD
--    count); its movements point at it through inventory_movements.batch_id.
-- 3. inventory_movements.signed_qty: a count's variance with its sign, so
--    suggestions don't have to read it back out of the reason text.
-- 4. item_edit_log: who changed what on an item (name, unit, batch recipe,
--    mode), shown on the item page.
-- 5. suggestion_dismissals: suggestions someone said no to.
--    ingredient_counts: every count (a perfect one too -- it leaves no
--    count_adjustment movement), what was expected and the difference.
--    ingredient_daily_usage(since): use per ingredient per PH day, added
--    up in the database (a month of sale lines is too many rows to fetch).
-- 6. recipe_lines_expanded(size): a menu size's recipe with 'auto' bases
--    replaced by their components. The bundle functions now use it, the same
--    way the Python sale path does (app/prep_chain.py).
--
-- Only adds columns, tables and functions: safe to apply before the code.

alter table ingredients add column if not exists deduct_mode text not null default 'batch'
  check (deduct_mode in ('batch', 'auto'));

create table if not exists prep_batches (
  id uuid primary key default gen_random_uuid(),
  base_ingredient_id uuid not null references ingredients(id) on delete cascade,
  batches numeric(12, 4) not null check (batches > 0),
  yield_qty numeric(14, 4) not null,
  source text not null default 'manual' check (source in ('manual', 'eod')),
  note text,
  made_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists prep_batches_base_idx on prep_batches(base_ingredient_id, created_at desc);

alter table inventory_movements add column if not exists batch_id uuid references prep_batches(id) on delete set null;
alter table inventory_movements add column if not exists signed_qty numeric;
create index if not exists inventory_movements_batch_idx on inventory_movements(batch_id) where batch_id is not null;

create table if not exists item_edit_log (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid references ingredients(id) on delete cascade,
  stock_item_id uuid references stock_items(id) on delete cascade,
  field text not null,
  before jsonb,
  after jsonb,
  changed_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  check ((ingredient_id is null) <> (stock_item_id is null))
);
create index if not exists item_edit_log_ingredient_idx on item_edit_log(ingredient_id, created_at desc);
create index if not exists item_edit_log_stock_item_idx on item_edit_log(stock_item_id, created_at desc);

create table if not exists suggestion_dismissals (
  key text primary key,
  dismissed_by uuid references profiles(id),
  dismissed_at timestamptz not null default now()
);

create table if not exists ingredient_counts (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  expected numeric(14, 4) not null,
  counted numeric(14, 4) not null,
  variance numeric(14, 4) not null,
  counted_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists ingredient_counts_idx on ingredient_counts(ingredient_id, created_at desc);

grant all on prep_batches, item_edit_log, suggestion_dismissals, ingredient_counts to service_role;
alter table ingredient_counts enable row level security;
alter table prep_batches enable row level security;
alter table item_edit_log enable row level security;
alter table suggestion_dismissals enable row level security;

-- Use per ingredient per Philippines day since p_since: sold + taken out
-- by hand (batches) + transferred out, minus voided sales.
create or replace function ingredient_daily_usage(p_since date)
returns table (ingredient_id uuid, day date, used numeric)
language sql stable set search_path = public as $$
  select m.ingredient_id, (m.created_at at time zone 'Asia/Manila')::date,
         round(sum(case when m.type in ('sale_consumption', 'trans_out', 'transfer_out') then m.quantity
                        when m.type = 'sale_consumption_reversal' then -m.quantity else 0 end), 4)
    from inventory_movements m
    where m.ingredient_id is not null
      and m.created_at >= (p_since::timestamp at time zone 'Asia/Manila')
      and m.type in ('sale_consumption', 'sale_consumption_reversal', 'trans_out', 'transfer_out')
    group by 1, 2
$$;
revoke all on function ingredient_daily_usage(date) from public, anon, authenticated;
grant execute on function ingredient_daily_usage(date) to service_role;

-- A size's recipe with 'auto' bases opened up into what they're made of
-- (qty * component qty / yield), up to 5 levels deep, merged per ingredient.
create or replace function recipe_lines_expanded(p_size_id uuid)
returns table (ingredient_id uuid, qty_per_serving numeric)
language sql stable set search_path = public as $$
  with recursive lines(ingredient_id, qty, depth) as (
    select r.ingredient_id, r.qty_per_serving::numeric, 0
      from recipe_items r where r.product_size_id = p_size_id
    union all
    select p.ingredient_id, l.qty * p.qty / i.prep_yield, l.depth + 1
      from lines l
      join ingredients i on i.id = l.ingredient_id and i.deduct_mode = 'auto' and i.prep_yield is not null
      join prep_recipe_items p on p.base_ingredient_id = i.id
      where l.depth < 5
  )
  select l.ingredient_id, round(sum(l.qty), 4)
    from lines l join ingredients i on i.id = l.ingredient_id
    where not (i.deduct_mode = 'auto' and i.prep_yield is not null and l.depth < 5
               and exists (select 1 from prep_recipe_items p where p.base_ingredient_id = i.id))
    group by l.ingredient_id
$$;
revoke all on function recipe_lines_expanded(uuid) from public, anon, authenticated;
grant execute on function recipe_lines_expanded(uuid) to service_role;

-- Bundles: same as 0063 / 0066, but the recipe goes through recipe_lines_expanded.
create or replace function fulfill_bundle_atomic(
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
      cross join lateral recipe_lines_expanded(x.product_size_id) r
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

create or replace function reconcile_pending_bundle_atomic(p_item_id uuid, p_employee_id uuid)
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
      from bundle_fulfillments f cross join lateral recipe_lines_expanded(f.product_size_id) r
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

revoke all on function fulfill_bundle_atomic(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function reconcile_pending_bundle_atomic(uuid, uuid) from public, anon, authenticated;
grant execute on function fulfill_bundle_atomic(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function reconcile_pending_bundle_atomic(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
