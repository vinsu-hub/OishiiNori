-- Staff onboarding: a new or reset account gets a one-time temporary
-- password and must replace it on first login. The dashboard routes a user
-- with this flag to its Change Password screen until POST
-- /me/change-password clears it (which also nulls current_password, so a
-- password the employee chose is never kept in plain text).
alter table profiles add column must_change_password boolean not null default false;
