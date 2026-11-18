-- Ingredients that are no longer part of inventory (EOD Stock Count's
-- remove button). Removing keeps the row -- sales, counts and movements
-- still point at it -- and hides it from stock counts, alerts and pickers.
-- It can be restored. An ingredient still in a menu recipe can't be
-- removed (the API refuses).
alter table ingredients add column if not exists active boolean not null default true;
