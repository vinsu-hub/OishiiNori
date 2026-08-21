-- Held-ingredient customization for real transaction items, not just
-- digital_order_items. Requested by the user: POS Terminal (cashier side)
-- gets an "Edit Order" button to hold ingredients before checkout, same
-- concept the digital menu already has via digital_order_items.
-- held_ingredients -- but that column only exists on the staging-area
-- digital_order_items table, not on transaction_items, so a POS-originated
-- hold had nowhere to live and an approved digital order's holds were
-- silently dropped when _create_transaction_row built the real sale.
--
-- Same shape as digital_order_items.held_ingredients (see migration 0017):
-- free-text ingredient names, drawn client-side from the product's real
-- recipe_items -- informational for the kitchen, not an automatic recipe
-- recalculation.

alter table transaction_items add column held_ingredients text[] not null default '{}';
