-- Cash taken from the register for day-to-day operating expenses.
-- Kept separate from sales, losses, utility readings and rider payouts.
create table cash_expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null check (length(trim(description)) > 0),
  amount numeric(10,2) not null check (amount > 0),
  business_date date not null,
  recorded_by uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index idx_cash_expenses_business_date on cash_expenses(business_date, created_at desc);
alter table cash_expenses enable row level security;
