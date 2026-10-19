-- Station Items follow the client's own stock sheet (INVENTORY COFFEE
-- GRIND.xlsx): one sheet per station, items in the sheet's row order and
-- grouped into sections (stock_items.category). sort_order is that row
-- position; scripts/apply_client_stock_layout.py fills it in. Null sorts
-- last, so items added later show at the end of their section.
alter table stock_items add column if not exists sort_order integer;
create index if not exists idx_stock_items_station_sort on stock_items(station, sort_order);
