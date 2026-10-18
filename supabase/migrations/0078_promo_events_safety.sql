-- 2026-10-19 owner requests: first-online-order promo, events with sign-ups,
-- and housekeeping for the public rate limiter.

-- 1. First online order of the day gets a free item --------------------------
-- One row per PH date: the primary key makes "first" atomic across
-- concurrent submissions. Deleted when that order is declined, so the next
-- customer that day can still win.
create table if not exists online_promo_claims (
  promo_date date primary key,
  digital_order_id uuid not null unique references digital_orders(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table online_promo_claims enable row level security;

alter table digital_order_items
  add column if not exists is_promo boolean not null default false;

-- Which product size is given away; null turns the promo off.
alter table business_settings
  add column if not exists first_order_promo_size_id uuid references product_sizes(id) on delete set null;

update business_settings
set first_order_promo_size_id = (
  select ps.id from product_sizes ps join products p on p.id = ps.product_id
  where p.name = 'Torikatsu Maki' and ps.size_label = '4 pcs'
  limit 1
)
where id = 1 and first_order_promo_size_id is null;

-- 2. Events shown on the website, with sign-ups -------------------------------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  location text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz,
  price_label text,
  image_url text,
  listed boolean not null default true,
  signups_open boolean not null default true,
  slots_full boolean not null default false,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists events_starts_at_idx on events(starts_at);
alter table events enable row level security;

create table if not exists event_signups (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  phone text not null,
  email text,
  slots int not null default 1 check (slots between 1 and 20),
  notes text,
  status text not null default 'new' check (status in ('new', 'confirmed', 'cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists event_signups_event_idx on event_signups(event_id, created_at);
alter table event_signups enable row level security;

-- 3. Rate limiter housekeeping -------------------------------------------------
-- Same behaviour as 0049, plus an occasional sweep of old windows so the
-- counters table doesn't grow forever.
create or replace function check_rate_limit(p_key text, p_window_seconds int, p_limit int)
returns boolean
language plpgsql
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count int;
begin
  insert into rate_limit_counters (bucket_key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (bucket_key, window_start) do update set count = rate_limit_counters.count + 1
  returning count into v_count;

  if random() < 0.02 then
    delete from rate_limit_counters where window_start < now() - interval '1 day';
  end if;

  return v_count <= p_limit;
end;
$$;
