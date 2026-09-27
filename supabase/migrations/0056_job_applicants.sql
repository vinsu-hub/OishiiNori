-- Careers / "Join Our Crew" applications: a public, unauthenticated submission
-- from the Landing Page (name/phone/email, then an optional resume photo)
-- staged into a queue that manager/executive staff work through in
-- dashboard-web's Applicants tab. Same shape as reviews/inquiries -- every
-- access goes through the FastAPI service-role client, which bypasses RLS.

create table job_applicants (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 1 and 120),
  phone text not null check (char_length(phone) between 3 and 40),
  email text not null check (char_length(email) between 3 and 200),
  position_interest text,
  message text,
  -- Resume is a photographed/scanned image (jpg or png only, enforced at the
  -- API layer) uploaded in a second step, same optional-second-step pattern
  -- as reviews.photo_url -- a submission with no photo yet is still complete.
  resume_photo_url text,
  status text not null default 'new' check (status in ('new', 'reviewed', 'contacted', 'rejected', 'hired')),
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_job_applicants_status_created on job_applicants (status, created_at desc);

alter table job_applicants enable row level security;
