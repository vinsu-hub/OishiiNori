-- Grab orders are paid through the platform and settle outside the cash drawer.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_payment_method_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_payment_method_check
  CHECK (payment_method IN ('cash', 'gcash', 'card', 'bdo', 'maya', 'grab'));
