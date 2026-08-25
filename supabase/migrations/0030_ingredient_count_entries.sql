-- Extends 0028's polymorphic pattern (inventory_movements/loss_records) to
-- stock_count_entries: Station Items' computed New Stocks/Beginning/Usage/
-- Ending summary (0028) never applied to plain recipe ingredients, even
-- though ingredient stock has been sale-driven-automated since the original
-- build (recipe_items -> _adjust_ingredients_for_size). This lets a plain
-- ingredient (no wrapping stock_items row) get the same computed-summary +
-- flag-to-correct treatment, reusing the one table instead of a second,
-- parallel "ingredient_count_entries" table.

alter table stock_count_entries alter column stock_item_id drop not null;
alter table stock_count_entries add column ingredient_id uuid references ingredients(id) on delete cascade;

alter table stock_count_entries add constraint stock_count_entries_exactly_one_target
  check (
    (stock_item_id is not null and ingredient_id is null)
    or (stock_item_id is null and ingredient_id is not null)
  );

-- Replaces the old plain UNIQUE(stock_item_id, count_date) (which no longer
-- makes sense once stock_item_id is nullable) with two partial unique
-- indexes, same technique 0028 already used for stock_consumption_rules.
alter table stock_count_entries drop constraint stock_count_entries_stock_item_id_count_date_key;

create unique index uq_stock_count_entries_stock_item_date
  on stock_count_entries(stock_item_id, count_date)
  where stock_item_id is not null;
create unique index uq_stock_count_entries_ingredient_date
  on stock_count_entries(ingredient_id, count_date)
  where ingredient_id is not null;

create index idx_stock_count_entries_ingredient on stock_count_entries(ingredient_id);
