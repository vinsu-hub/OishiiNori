-- Kitchen print bridge status: a singleton row the bridge (kitchen-print-
-- bridge/bridge.py, running on-prem next to the XP-58H) reports to on every
-- poll cycle, so dashboard-web's Printer Setup tab can show whether the
-- bridge is alive and printing -- without the hosted dashboard needing any
-- direct network path to the bridge's machine (it may not even be on the
-- same network as whoever's viewing the dashboard). Same singleton-row
-- pattern as business_settings (migration 0023).

create table kitchen_printer_status (
  id smallint primary key default 1 check (id = 1),
  last_heartbeat_at timestamptz,
  last_print_at timestamptz,
  last_print_order_number integer,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into kitchen_printer_status (id) values (1);

alter table kitchen_printer_status enable row level security;
