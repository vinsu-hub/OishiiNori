-- Oishii Nori Command Suite — Phase 1 schema
-- Single branch (one physical store), two departments: kitchen and cafe.
-- Unlike the SMFC reference this system is built from (multi-branch), there
-- is deliberately NO organizations/branches table and NO branch_id anywhere
-- in this schema — see repo-level task notes for the locked scope decision.
--
-- This migration lays the foundation: extensions, the department_type enum
-- (used later by transfers/stock_requests/inventory_movements/products to
-- express the kitchen/cafe split that stands in for SMFC's branch scoping),
-- and `profiles`, which extends auth.users with role/pay/kiosk fields.
--
-- JUDGMENT CALL: `profiles` is not in the task's explicit table list, but
-- every other requested table (transactions.employee_id, loss_records,
-- attendance_logs, payroll_records, payroll_overrides, payroll_audit_log,
-- utility_logs.recorded_by, stock_requests.requested_by, ...) needs a
-- profiles-like identity table to reference. Modeled after SMFC's profiles
-- table minus branch_id, with HR/kiosk columns folded in directly (SMFC
-- added these via several later ALTERs; since this is a fresh build we
-- write the final shape once rather than replaying that history).

create extension if not exists "pgcrypto";

create type department_type as enum ('kitchen', 'cafe');

create type user_role as enum ('employee', 'manager', 'executive');

-- profiles extends auth.users. id must equal auth.users.id.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'employee',
  full_name text,
  department department_type,
  "position" text,
  pay_rate numeric(10, 2) not null default 0,
  payroll_schedule text not null default 'biweekly',
  employee_number text unique,
  kiosk_pin_hash text,
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column profiles.kiosk_pin_hash is 'bcrypt hash of the employee''s Staff Clock kiosk PIN. Never exposed to any client; only compared server-side by the FastAPI backend (services/api-fastapi), same pattern as the SMFC reference.';
comment on column profiles.employee_number is 'Short numeric/ID code employees enter on the Staff Clock kiosk (distinct from their login email).';

create index idx_profiles_department on profiles(department);
create index idx_profiles_role on profiles(role);

-- RLS -------------------------------------------------------------------
-- JUDGMENT CALL (applies to every migration in this Phase 1 set, noted
-- once here): no dashboard-web / api-fastapi app code exists yet, and
-- there is no branch concept to scope policies by like SMFC does. Rather
-- than invent role-scoped policies against a not-yet-built auth flow, RLS
-- is enabled everywhere (safe-by-default: anon and authenticated are
-- denied unless a policy says otherwise) and kept deliberately minimal:
--   - service_role (the FastAPI backend's key) bypasses RLS entirely in
--     Supabase, so it always has full access without an explicit policy.
--   - `authenticated` gets read-only SELECT policies on catalog/reference
--     and operational tables (menu, inventory, transactions, discounts —
--     data a dashboard would reasonably need to display).
--   - `authenticated` gets NO policy at all (i.e. no access) on sensitive
--     HR/payroll tables (profiles beyond "own row", attendance, payroll
--     records/items/overrides/audit log) — those stay service_role-only
--     until Phase 2 designs real role-based authorization.
--   - No table gets INSERT/UPDATE/DELETE policies for `authenticated` in
--     this pass; all writes go through the FastAPI service-role client,
--     mirroring the comment already in the SMFC reference's hr-schema
--     migration ("nothing... queries these tables directly -- everything
--     goes through FastAPI's service-role client").
-- Flagged explicitly per the task instructions as a judgment call, not a
-- deferral — RLS is ON for every table below, just narrow in scope.

alter table profiles enable row level security;

create policy "Users can read their own profile"
  on profiles for select
  using (auth.uid() = id);
