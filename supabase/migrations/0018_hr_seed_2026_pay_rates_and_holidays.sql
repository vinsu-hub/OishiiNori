-- Seed DOLE Labor Advisory 12-25 multiplier rates and the 2026 PH holiday
-- calendar. CRITICAL FIX: 0011 created these tables with zero seed rows,
-- so every attendance log has silently fallen through to the flat-rate
-- fallback (_FLAT_RULE in hr.py) since go-live -- no employee has ever
-- received a holiday premium or night-diff addon despite the engine being
-- "always on" in this build.

insert into hr.pay_multiplier_rules (scenario_key, not_worked_pct, first_8hr_pct, ot_addon_pct, night_diff_addon_pct) values
  ('regular_day', 0, 100, 25, 10),
  ('regular_holiday', 100, 200, 25, 10),
  ('regular_holiday_rest_day', 100, 260, 30, 10),
  ('special_non_working', 0, 130, 30, 10),
  ('special_non_working_rest_day', 0, 150, 30, 10),
  ('special_working', 0, 100, 25, 10),
  ('rest_day', 0, 130, 30, 10);

insert into hr.holidays (holiday_date, name, holiday_type, is_recurring) values
  ('2026-01-01', 'New Year''s Day', 'regular_holiday', true),
  ('2026-04-02', 'Maundy Thursday', 'regular_holiday', false),
  ('2026-04-03', 'Good Friday', 'regular_holiday', false),
  ('2026-04-09', 'Araw ng Kagitingan', 'regular_holiday', true),
  ('2026-05-01', 'Labor Day', 'regular_holiday', true),
  ('2026-06-12', 'Independence Day', 'regular_holiday', true),
  ('2026-08-31', 'National Heroes Day', 'regular_holiday', false),
  ('2026-11-30', 'Bonifacio Day', 'regular_holiday', true),
  ('2026-12-25', 'Christmas Day', 'regular_holiday', true),
  ('2026-12-30', 'Rizal Day', 'regular_holiday', true),
  ('2026-02-17', 'Chinese New Year', 'special_non_working', false),
  ('2026-04-04', 'Black Saturday', 'special_non_working', false),
  ('2026-08-21', 'Ninoy Aquino Day', 'special_non_working', true),
  ('2026-11-01', 'All Saints'' Day', 'special_non_working', true),
  ('2026-11-02', 'All Souls'' Day', 'special_non_working', true),
  ('2026-12-08', 'Feast of the Immaculate Conception', 'special_non_working', true),
  ('2026-12-24', 'Christmas Eve', 'special_non_working', true),
  ('2026-12-31', 'Last Day of the Year', 'special_non_working', true),
  ('2026-02-25', 'EDSA People Power Anniversary', 'special_working', false);
