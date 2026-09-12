-- Executive-only "view credentials" feature: an employee's login email,
-- current password, and current kiosk PIN, retrievable again after
-- creation (previously shown once and then discarded/hashed away).
-- User explicitly confirmed storing these in plain text is acceptable for
-- this internal tool, gated to executives at the app layer.
alter table profiles add column email text;
alter table profiles add column current_password text;
alter table profiles add column current_pin text;
