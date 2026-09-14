-- Rate limiting for the public/unauthenticated endpoints most exposed to a
-- scripted flood: the kiosk PIN-verify endpoint (a real "swarm of queries"
-- risk -- no throttling meant a scripted client could brute-force PIN
-- guesses against a known employee number) and the public reservation/
-- order/availability endpoints.
--
-- The backend is FastAPI on Vercel serverless -- each invocation can be a
-- fresh container, so an in-process limiter (e.g. an in-memory counter)
-- would not actually work: two concurrent requests hitting different
-- containers would each see an empty counter. Postgres is the only real
-- shared state available, so the check+increment happens in one atomic
-- statement here (same "push the race into one SQL statement" pattern as
-- migration 0046's stock RPCs) rather than a select-then-compare-then-write
-- that would just relocate the race into the rate limiter itself.

create table rate_limit_counters (
  bucket_key text not null,
  window_start timestamptz not null,
  count int not null default 1,
  primary key (bucket_key, window_start)
);

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

  return v_count <= p_limit;
end;
$$;

-- RLS -----------------------------------------------------------------------
-- Fail-closed, same posture as every other table here -- all access is via
-- the FastAPI service-role client, which bypasses RLS. No anon/authenticated
-- policies needed or added.
alter table rate_limit_counters enable row level security;
