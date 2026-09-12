-- Split payment method removed from POS (no special handling existed for
-- it anywhere in the app -- it was just one more literal value). Zero
-- existing transactions rows use payment_method = 'split' (verified live
-- before writing this migration), so tightening the constraint is safe
-- with no backfill needed.

alter table transactions
  drop constraint transactions_payment_method_check;

alter table transactions
  add constraint transactions_payment_method_check
  check (payment_method in ('cash', 'gcash', 'card'));
