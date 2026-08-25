-- POS order context (table/guest/order-type) and payment method, persisted
-- for real on the transaction -- unlike the SMFC reference project's own
-- payment-method buttons, which are confirmed dead UI (clicked, styled,
-- never sent to checkout). order_type/table_number/guest_count mirror the
-- reference's Dine In/Takeout toggle + table input + guest stepper;
-- payment_method mirrors digital_orders.payment_method (0016) in spirit
-- but is its own column with its own check constraint, since POS supports
-- two more values (card, split) than the 2-value QR-ordering flow.
--
-- All four columns are nullable: existing rows have none of them, and
-- digital-menu order approval (digital_menu.py's approve_digital_order,
-- which shares transactions.py's _create_transaction_row) does not send
-- them in this pass, so they must not be NOT NULL.

alter table transactions
  add column order_type text check (order_type in ('dine_in', 'takeout')),
  add column table_number int check (table_number > 0),
  add column guest_count int check (guest_count > 0),
  add column payment_method text check (payment_method in ('cash', 'gcash', 'card', 'split'));
