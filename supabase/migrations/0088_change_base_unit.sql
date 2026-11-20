-- Change an item's main (base) unit and convert every number stored in it.
--
-- Until now base_unit was only a label: switching "J rice cooked" from pcs
-- to g left 40 "pcs" of stock reading as 40 g. This function takes the
-- conversion (1 old unit = p_factor new units) and rescales, in one
-- transaction, everything that is stored in the item's base unit:
--   stock, alert level, saved sizes, recipe and batch lines, batch yield,
--   count history, movements, losses, transfers, requests, bundle
--   deductions and station consumption rules.
-- Money per unit (unit_cost, cost snapshots, cost log) is divided by the
-- factor so values in pesos stay the same.
-- The old unit is kept as a saved size ("1 pcs = 120 g") so people who
-- still count the old way can keep doing so.
--
-- p_kind is 'ingredient' or 'stock_item' (an unlinked station item).

create or replace function change_item_base_unit(
  p_kind text,
  p_id uuid,
  p_new_unit text,
  p_factor numeric,
  p_keep_old_as_size boolean default true
) returns void
language plpgsql
as $$
declare
  v_old text;
  v_new text := lower(btrim(p_new_unit));
begin
  if p_factor is null or p_factor <= 0 then
    raise exception 'Conversion must be more than 0';
  end if;
  if v_new = '' then
    raise exception 'New unit is required';
  end if;

  if p_kind = 'ingredient' then
    select base_unit into v_old from ingredients where id = p_id for update;
    if not found then raise exception 'Ingredient not found'; end if;

    update ingredients set
      base_unit = v_new,
      current_stock = current_stock * p_factor,
      reorder_threshold = reorder_threshold * p_factor,
      unit_cost = round(unit_cost / p_factor, 4),
      prep_yield = prep_yield * p_factor,
      updated_at = now()
    where id = p_id;

    -- Saved sizes: "pack = 10 pcs" becomes "pack = 1200 g". A size with the
    -- new unit's own name is now the base itself, so it goes.
    delete from item_units where ingredient_id = p_id and lower(name) = v_new;
    update item_units set base_qty = base_qty * p_factor where ingredient_id = p_id;
    if p_keep_old_as_size and lower(btrim(coalesce(v_old, ''))) not in ('', v_new) then
      insert into item_units (ingredient_id, name, base_qty)
      values (p_id, lower(btrim(v_old)), p_factor)
      on conflict do nothing;
    end if;

    update recipe_items set
      qty_per_serving = qty_per_serving * p_factor,
      unit = case when lower(btrim(coalesce(unit, ''))) in ('', lower(btrim(coalesce(v_old, '')))) then v_new else unit end
    where ingredient_id = p_id;
    -- Batch lines store qty in the component's base unit; unit is a label.
    update prep_recipe_items set
      qty = qty * p_factor,
      unit = case when lower(btrim(coalesce(unit, ''))) in ('', lower(btrim(coalesce(v_old, '')))) then v_new else unit end
    where ingredient_id = p_id;

    update stock_count_entries set
      new_stocks = new_stocks * p_factor,
      beginning = beginning * p_factor,
      usage = usage * p_factor,
      ending = ending * p_factor
    where ingredient_id = p_id;
    update inventory_movements set
      quantity = greatest(quantity * p_factor, 0.0001),
      unit_cost_snapshot = unit_cost_snapshot / p_factor
    where ingredient_id = p_id;
    update loss_records set quantity = greatest(round(quantity * p_factor, 4), 0.0001) where ingredient_id = p_id;
    update transfers set quantity = quantity * p_factor where ingredient_id = p_id;
    update stock_requests set quantity = quantity * p_factor where ingredient_id = p_id;
    update bundle_ingredient_deductions set quantity = quantity * p_factor where ingredient_id = p_id;
    update ingredient_cost_log set
      unit_cost = round(unit_cost / p_factor, 4),
      previous_unit_cost = round(previous_unit_cost / p_factor, 4),
      base_qty = case when base_qty is null then null else greatest(round(base_qty * p_factor, 4), 0.0001) end
    where ingredient_id = p_id;

    -- A station item linked to this ingredient is the same thing.
    update stock_items set unit = v_new, updated_at = now() where ingredient_id = p_id;

  elsif p_kind = 'stock_item' then
    select coalesce(unit, 'pcs') into v_old from stock_items where id = p_id for update;
    if not found then raise exception 'Station item not found'; end if;
    if exists (select 1 from stock_items where id = p_id and ingredient_id is not null) then
      raise exception 'This station item is linked to an ingredient: change the ingredient''s unit instead';
    end if;

    update stock_items set
      unit = v_new,
      current_stock = current_stock * p_factor,
      reorder_threshold = reorder_threshold * p_factor,
      updated_at = now()
    where id = p_id;

    delete from item_units where stock_item_id = p_id and lower(name) = v_new;
    update item_units set base_qty = base_qty * p_factor where stock_item_id = p_id;
    if p_keep_old_as_size and lower(btrim(coalesce(v_old, ''))) not in ('', v_new) then
      insert into item_units (stock_item_id, name, base_qty)
      values (p_id, lower(btrim(v_old)), p_factor)
      on conflict do nothing;
    end if;

    update stock_count_entries set
      new_stocks = new_stocks * p_factor,
      beginning = beginning * p_factor,
      usage = usage * p_factor,
      ending = ending * p_factor
    where stock_item_id = p_id;
    update inventory_movements set quantity = greatest(quantity * p_factor, 0.0001) where stock_item_id = p_id;
    update loss_records set quantity = greatest(round(quantity * p_factor, 4), 0.0001) where stock_item_id = p_id;
    update stock_consumption_rules set qty_per_unit = greatest(round(qty_per_unit * p_factor, 4), 0.0001) where stock_item_id = p_id;
  else
    raise exception 'Unknown item kind %', p_kind;
  end if;
end;
$$;

revoke all on function change_item_base_unit(text, uuid, text, numeric, boolean) from public, anon, authenticated;
grant execute on function change_item_base_unit(text, uuid, text, numeric, boolean) to service_role;

-- Let the API (PostgREST) see the new function right away.
notify pgrst, 'reload schema';
