-- Employee deactivation (offboarding): profiles had no active/status
-- column at all, so there was no way to remove a departed employee
-- short of a hard delete -- which fails on any real history (sales,
-- attendance, inventory movements) via foreign key, or destroys it if
-- forced. This adds the same soft-delete pattern products/discount_types
-- already use. Default true so every existing account stays usable.

alter table profiles add column active boolean not null default true;
