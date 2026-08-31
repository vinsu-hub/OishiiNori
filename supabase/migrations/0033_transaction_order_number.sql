-- Human-friendly POS order numbers.
--
-- transactions has only a uuid id (0006); Order Queue / Kitchen Display key
-- their tickets off id.slice(0, 8), which staff can't read out loud. This adds
-- a per-day sequential order_number that resets to 1001 each PH business day
-- ("order for 1042"). digital_orders already has an analogous order_number
-- (0016) -- this is the same idea for the POS/KDS side.
--
-- Assigned by a BEFORE INSERT trigger, so it covers both the POS charge path
-- and digital-order approval (both insert via transactions.py's
-- _create_transaction_row). An offline-queued sale that replays later is
-- numbered at replay time, not original sale time -- acceptable for a rare
-- edge, and the number still lands on the day it replays.
--
-- Concurrency: the counter bump is a single atomic
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so two simultaneous charges
-- can't get the same number. The unique index is a belt-and-braces guard.

create table transaction_daily_counters (
  business_date date primary key,
  last_number   int  not null
);

alter table transaction_daily_counters enable row level security;

create policy "Authenticated users can read daily order counters"
  on transaction_daily_counters for select
  using (auth.role() = 'authenticated');

alter table transactions add column order_number int;

-- Backfill existing rows: number them per PH-day in opened_at order, from 1001.
with numbered as (
  select
    id,
    1000 + row_number() over (
      partition by (opened_at at time zone 'Asia/Manila')::date
      order by opened_at, id
    ) as n
  from transactions
)
update transactions t
  set order_number = numbered.n
  from numbered
  where numbered.id = t.id;

-- Seed the counters so new inserts continue each day's sequence correctly.
insert into transaction_daily_counters (business_date, last_number)
  select (opened_at at time zone 'Asia/Manila')::date, max(order_number)
  from transactions
  where order_number is not null
  group by 1;

create or replace function assign_transaction_order_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d date := (new.opened_at at time zone 'Asia/Manila')::date;
  n int;
begin
  insert into transaction_daily_counters (business_date, last_number)
    values (d, 1001)
    on conflict (business_date) do update
      set last_number = transaction_daily_counters.last_number + 1
    returning last_number into n;
  new.order_number := n;
  return new;
end
$$;

create trigger trg_assign_order_number
  before insert on transactions
  for each row
  when (new.order_number is null)
  execute function assign_transaction_order_number();

create unique index idx_transactions_daily_order_number
  on transactions (((opened_at at time zone 'Asia/Manila')::date), order_number);
