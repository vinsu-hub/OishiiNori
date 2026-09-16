-- Customer Reviews: public submission (Landing Page) -> staff moderation
-- queue (dashboard-web), same "pending -> approved/rejected" shape as
-- digital_orders/reservations. Admin-only for now -- no public display of
-- approved reviews yet, a clear follow-up if wanted later.

create table reviews (
  id uuid primary key default gen_random_uuid(),
  is_anonymous boolean not null default false,
  customer_name text,
  rating smallint not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 1 and 600),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejected_reason text,
  -- Set on either outcome (approve or reject), same neutral-naming posture
  -- as refunds.reviewed_by/reviewed_at -- "approved_by" would read oddly
  -- on a rejected row.
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  -- A named review must actually carry a name; an anonymous one never
  -- does (enforced again, defensively, at the API layer before insert --
  -- this constraint is the last line of defense, not the only one).
  constraint reviews_name_required_unless_anonymous check (is_anonymous or customer_name is not null)
);

create index idx_reviews_status on reviews (status);

-- Fail-closed, same posture as every other table here -- both the public
-- (unauthenticated) and staff-facing endpoints go through the FastAPI
-- service-role client, which bypasses RLS entirely.
alter table reviews enable row level security;
