-- Two independent POS additions:
--
-- 1. card_type: when payment_method = 'card', the cashier now picks
--    Debit or Credit in a follow-up prompt (POSTerminal.tsx). Nullable
--    since cash/gcash/split orders never set it.
--
-- 2. force_vat_exempt: an explicit VAT/Non-VAT toggle in POS, independent
--    of the selected discount's own vat_exempt flag. Previously vat_exempt
--    could only come from a discount (see create_transaction in
--    transactions.py); this lets a cashier book an order non-VAT with no
--    VAT-exempt discount applied. Defaults false so existing behavior is
--    unchanged unless a cashier explicitly flips it.

alter table transactions
  add column card_type text check (card_type in ('debit', 'credit'));

alter table transactions
  add column force_vat_exempt boolean not null default false;
