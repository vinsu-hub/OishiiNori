-- Pay-on-delivery (cash collected by the rider) for POS delivery orders.
--
-- Facebook/phone delivery orders are punched into the POS, cooked, picked
-- up and delivered by a rider, who collects the cash and brings it back.
-- Until then the sale is not in the drawer, so it is recorded as 'unpaid'
-- and settled at the counter when the rider hands the money over.
--
-- Every existing (and every non-delivery) sale is 'paid' at charge time,
-- exactly as before -- the default keeps that unchanged.

alter table transactions
  add column if not exists payment_status text not null default 'paid'
    check (payment_status in ('paid', 'unpaid')),
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by uuid references profiles(id) on delete set null;

create index if not exists idx_transactions_unpaid
  on transactions (opened_at)
  where payment_status = 'unpaid';
