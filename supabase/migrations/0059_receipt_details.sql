-- Customer receipt (order slip) header/footer, editable in Settings ->
-- Receipt details. All optional: a blank field simply isn't printed.
alter table business_settings
  add column receipt_business_name text,
  add column receipt_address text,
  add column receipt_phone text,
  add column receipt_tin text,
  add column receipt_footer text;
