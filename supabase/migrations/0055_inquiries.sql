-- Website inquiries: Contact-form messages and Catering requests submitted
-- publicly from the Landing Page, surfaced to staff in dashboard-web's
-- Inquiries tab. Same fail-closed posture as reviews -- every access goes
-- through the FastAPI service-role client, which bypasses RLS.

create table inquiries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contact', 'catering')),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 200),
  phone text,
  message text not null check (char_length(message) between 1 and 2000),
  event_date date,
  guest_count integer check (guest_count is null or guest_count between 1 and 100000),
  status text not null default 'new' check (status in ('new', 'handled')),
  handled_by uuid references profiles(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_inquiries_status_created on inquiries (status, created_at desc);

alter table inquiries enable row level security;
