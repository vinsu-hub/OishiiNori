-- Optional single photo attach for a Customer Review, uploaded in a second
-- step after submission (same "create, then attach a file to what you just
-- created" shape as digital_orders.payment_proof_url).

alter table reviews add column photo_url text;
