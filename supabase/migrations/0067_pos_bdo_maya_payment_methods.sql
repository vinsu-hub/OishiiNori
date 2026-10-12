-- Add distinct POS payment choices while retaining historical card subtypes.
-- Existing transaction rows are left untouched.
alter table transactions
  drop constraint transactions_payment_method_check;

alter table transactions
  add constraint transactions_payment_method_check
  check (payment_method in ('cash', 'gcash', 'card', 'bdo', 'maya'));
