-- Fixes a real lost-update race: _adjust_ingredients_for_size (transactions.py)
-- and apply_inventory_movement (inventory_movements.py) both used to
-- select current_stock, compute the new value in Python, then write the
-- absolute result back. Two POS terminals (or a POS sale and a manual count
-- adjustment) touching the same ingredient/stock item within the same
-- round-trip window would both read the same value; the second write
-- silently discarded the first's deduction.
--
-- PostgREST's `.update()` builder can only ever write a client-computed
-- absolute value -- it has no "current_stock = current_stock + :delta"
-- primitive -- so the fix is a single atomic SQL statement via RPC instead.
-- Both functions are called once per adjustment (never batched), same call
-- shape as the per-row UPDATE they replace.

create or replace function adjust_ingredient_stock(p_id uuid, p_delta numeric)
returns numeric
language plpgsql
as $$
declare
  v_new numeric;
begin
  update ingredients
  set current_stock = current_stock + p_delta,
      updated_at = now()
  where id = p_id
  returning current_stock into v_new;

  if v_new is null then
    raise exception 'Ingredient % not found', p_id;
  end if;

  return v_new;
end;
$$;

create or replace function adjust_stock_item_level(p_id uuid, p_delta numeric)
returns numeric
language plpgsql
as $$
declare
  v_new numeric;
begin
  update stock_items
  set current_stock = current_stock + p_delta,
      updated_at = now()
  where id = p_id
  returning current_stock into v_new;

  if v_new is null then
    raise exception 'Stock item % not found', p_id;
  end if;

  return v_new;
end;
$$;
