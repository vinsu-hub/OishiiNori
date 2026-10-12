-- Explicit channel attribution and per-delivery rider compensation.
alter table transactions add column order_source text not null default 'pos'
  check (order_source in ('pos', 'online', 'grab', 'qr'));

-- Preserve the source on existing web-menu transactions before switching to
-- the explicit field. QR table orders and general online orders are distinct.
update transactions t set order_source = case
  when d.order_channel = 'dine_in_qr' then 'qr'
  else 'online'
end
from digital_orders d
where d.transaction_id = t.id;

alter table deliveries add column rider_payout numeric(8,2)
  check (rider_payout is null or rider_payout >= 0);

create index idx_transactions_source_opened on transactions(order_source, opened_at);
