-- Seat-tracking for reservations. Until now a reservation had no lifecycle
-- state past 'confirmed' -- it just aged out silently when its time window
-- passed, and "Seat this reservation" only opened a POS order on the table
-- with no back-link. The Floor Plan's seating panel needs to know which
-- confirmed bookings have actually been seated so it can count how many
-- parties still need a table.
--
-- Deliberately NOT a new 'seated' value on the reservation_status enum: the
-- availability engine (_fetch_occupied_map / _blocking_reservation) keys off
-- status in ('pending','confirmed'), and a seated party must keep holding its
-- table. Separate nullable columns keep status meaning "still holding the
-- slot" while recording the seating event alongside it.

alter table reservations
  add column seated_at timestamptz,                                   -- null until the party is seated
  add column transaction_id uuid references transactions(id) on delete set null;  -- the POS order that seated them, when known

-- The Floor Plan and both other Reservations tabs now query by a single
-- selected day; 0025 has no index on this column.
create index if not exists idx_reservations_date on reservations(reservation_date);
