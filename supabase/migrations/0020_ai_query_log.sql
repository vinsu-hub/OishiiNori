-- Best-effort audit trail for Oishii AI queries -- written only by the
-- backend's service-role client, same rationale as hr.payroll_audit_log
-- (0013). Public schema (not hr) since this isn't payroll-specific.
create table public.ai_query_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index idx_ai_query_log_created on public.ai_query_log(created_at);

alter table public.ai_query_log enable row level security;

-- service_role-only, same rationale as 0010/0013.
