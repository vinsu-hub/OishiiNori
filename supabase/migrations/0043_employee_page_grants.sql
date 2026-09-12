-- Per-employee tab access grants, additive on top of the existing role
-- system. An employee's role still sets their access floor (unchanged);
-- this column lets an executive/manager grant specific individual employees
-- extra tabs beyond what their role alone would unlock (e.g. a cashier
-- granted Refund Approval without promoting them to manager).
alter table profiles add column extra_pages text[] not null default '{}';
