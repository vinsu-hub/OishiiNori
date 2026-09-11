-- WS-12: Refund approval flow. Void is narrowed (transactions.py) to
-- `queued` orders only -- once an order enters preparing/ready, the only
-- path to correct/cancel it is a cashier-initiated refund request that an
-- admin/executive must approve or reject (a completed order can't be
-- touched by either path). Approving performs the actual void (stock
-- restore etc.) via the same void_transaction_core the direct void
-- endpoint uses, just without its queued-only gate (an already-approved
-- refund is authorized regardless of the order's current kitchen_status).

create table refunds (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete restrict,
  requested_by uuid not null references profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references profiles(id) on delete restrict,
  reviewed_at timestamptz
);

create index idx_refunds_transaction_id on refunds (transaction_id);

-- One pending request per order at a time -- a second refund attempt on
-- the same still-pending order is a duplicate click, not a new request.
create unique index idx_refunds_one_pending_per_transaction
  on refunds (transaction_id)
  where status = 'pending';

-- Fail-closed like business_days (0035) / reservation_overrides (0031) --
-- deliberately no RLS policies; only the FastAPI service-role client
-- reads/writes this table.
alter table refunds enable row level security;
