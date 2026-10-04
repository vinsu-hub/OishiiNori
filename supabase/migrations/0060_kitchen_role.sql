-- Kitchen role: kitchen crew and the shared "Kitchen Tablet" account. Sees
-- only Kitchen Display (+ Order Queue, Help, Settings) and can't charge
-- sales (POST /transactions refuses it), so the kitchen tablet can never be
-- used as a POS or print a customer receipt.
alter type user_role add value 'kitchen';
