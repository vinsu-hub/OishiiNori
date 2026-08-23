-- Business-wide configurable settings, starting with VAT rate. Previously
-- hardcoded as 0.12 in two separate places (transactions.py's VAT_RATE and
-- the frontend's VAT_RATE_PREVIEW constant, with a code comment admitting
-- they "must be kept in sync" by hand) -- this table becomes the single
-- source of truth both read from.
--
-- Singleton table (id fixed at 1) rather than a generic key-value settings
-- table -- only one setting exists today; a key-value table would be
-- speculative generality for settings that don't exist yet.

create table business_settings (
  id smallint primary key default 1 check (id = 1),
  vat_rate numeric(5, 4) not null default 0.12,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into business_settings (id, vat_rate) values (1, 0.12);

-- RLS ---------------------------------------------------------------------
alter table business_settings enable row level security;

create policy "Authenticated users can read business settings"
  on business_settings for select
  using (auth.role() = 'authenticated');
