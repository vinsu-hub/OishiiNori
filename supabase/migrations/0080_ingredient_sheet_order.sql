-- EOD Stock Count (VS) lists ingredients the way the client's stock sheet
-- (INVENTORY COFFEE GRIND.xlsx) does: per station, grouped into the sheet's
-- sections, in row order -- same as Station Items (0079). Ingredients are
-- their own table, so they get their own placement: station (the
-- stock_station values), sheet_section, sort_order.
-- scripts/apply_ingredient_sheet_layout.py fills them in. category is left
-- alone; other pages use it. Null sort_order sorts last.
alter table ingredients add column if not exists station text;
alter table ingredients add column if not exists sheet_section text;
alter table ingredients add column if not exists sort_order integer;
create index if not exists idx_ingredients_station_sort on ingredients(station, sort_order);
