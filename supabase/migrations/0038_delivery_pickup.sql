-- WS-7: Delivery & Pickup ordering. The existing digital_orders flow
-- (0016) was QR-table-only (table_number hard NOT NULL). This loosens
-- that and adds an order_channel discriminator so the same staging-area
-- table also carries Delivery and Pickup orders placed through a general,
-- non-table link (apps/customer-menu, no ?table= param) -- approving any
-- of the three still creates a real transaction through the exact same
-- path (transactions.py's _create_transaction_row), just labeled
-- order_type='takeout' for delivery/pickup so kitchen packaging is
-- unambiguous.

alter table digital_orders alter column table_number drop not null;

alter table digital_orders add column order_channel text not null default 'dine_in_qr'
  check (order_channel in ('dine_in_qr', 'delivery', 'pickup'));

-- Barangay-based delivery fee reference, seeded from
-- documents/Santa_Cruz_Laguna_Barangay_Rider_Delivery_Fee_Table.xlsx
-- ("Suggested Delivery Fee" column). Editable later without a migration.
create table delivery_fees (
  id uuid primary key default gen_random_uuid(),
  barangay text not null unique,
  zone text not null,
  fee numeric(8, 2) not null
);

-- Extra fulfillment details for a delivery/pickup digital order -- name +
-- phone always; address/barangay/fee only populated for delivery.
-- rider_id/delivered_at are set later by the rider's "Delivery done".
create table deliveries (
  id uuid primary key default gen_random_uuid(),
  digital_order_id uuid not null unique references digital_orders(id) on delete cascade,
  customer_name text not null,
  customer_phone text not null,
  address text,
  landmark text,
  barangay text,
  delivery_fee numeric(8, 2),
  maps_pin_url text,
  rider_id uuid references profiles(id) on delete set null,
  delivered_at timestamptz
);

create index idx_deliveries_digital_order_id on deliveries (digital_order_id);

-- Fail-closed, same posture as every other table here -- both the public
-- (unauthenticated) and staff-facing endpoints go through the FastAPI
-- service-role client, which bypasses RLS entirely.
alter table delivery_fees enable row level security;
alter table deliveries enable row level security;

insert into delivery_fees (barangay, zone, fee) values
  ('Poblacion II', 'Pin / home zone', 45.00),
  ('Poblacion I', 'Central', 50.00),
  ('Poblacion III', 'Central', 50.00),
  ('Poblacion IV', 'Central', 55.00),
  ('Poblacion V', 'Central', 55.00),
  ('San Juan', 'Near', 70.00),
  ('Oogong', 'Near', 70.00),
  ('Santisima Cruz', 'Near', 75.00),
  ('Bagumbayan', 'Near', 80.00),
  ('Pagsawitan', 'Near', 80.00),
  ('San Jose', 'Near', 85.00),
  ('Duhat', 'Mid', 90.00),
  ('Bubukal', 'Mid', 95.00),
  ('Palasan', 'Mid', 95.00),
  ('Gatid', 'Mid', 95.00),
  ('Calios', 'Mid', 105.00),
  ('Labuin', 'Mid', 105.00),
  ('Patimbao', 'Mid', 110.00),
  ('San Pablo Norte', 'Mid', 110.00),
  ('Santo Angel Central', 'Mid', 110.00),
  ('San Pablo Sur', 'Mid', 115.00),
  ('Santo Angel Norte', 'Far', 125.00),
  ('Santo Angel Sur', 'Far', 125.00),
  ('Alipit', 'Far', 135.00),
  ('Malinao', 'Far', 140.00),
  ('Jasaan', 'Far', 150.00);
