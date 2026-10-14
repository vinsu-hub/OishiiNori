-- Persistent POS delivery drafts. Drafts do not create transactions or
-- deduct stock until explicitly sent to the kitchen.
create table if not exists public.pos_hanged_orders (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id),
  payload jsonb not null,
  status text not null default 'draft'
    check (status in ('draft', 'processing', 'submitted')),
  transaction_id uuid unique references public.transactions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pos_hanged_orders_status_created_idx
  on public.pos_hanged_orders(status, created_at desc);
create index if not exists pos_hanged_orders_employee_status_idx
  on public.pos_hanged_orders(employee_id, status);

alter table public.pos_hanged_orders enable row level security;
-- FastAPI uses the service role after authentication and ownership checks.
