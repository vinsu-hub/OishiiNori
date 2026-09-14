-- Closes the booking-time capacity TOCTOU documented as accepted-risk in an
-- earlier session: submit_reservation used to read today's reservations,
-- check bin-packing feasibility in Python, then insert -- two nearly-
-- simultaneous bookings for the last remaining slot's worth of capacity
-- could both pass the check before either committed.
--
-- Unlike migration 0047's table-overlap fix, capacity-pool feasibility
-- isn't expressible as a simple exclusion constraint -- it's a bin-packing
-- invariant across the whole active table set, not a pairwise overlap. The
-- fix is a single atomic function: an advisory lock scoped to the
-- reservation date serializes concurrent bookings for *that date* only
-- (never blocking bookings for other dates), then the exact same best-fit-
-- decreasing bin-pack check the Python code already does runs against a
-- live snapshot inside the same transaction as the insert, so nothing can
-- change between the check and the write.

create or replace function submit_reservation_atomic(
  p_party_size int,
  p_reservation_date date,
  p_start_time time,
  p_end_time time,
  p_customer_name text,
  p_customer_phone text,
  p_customer_note text,
  p_has_advance_order boolean
) returns reservations
language plpgsql
as $$
declare
  v_capacities int[];
  v_sizes int[];
  v_size int;
  v_idx int;
  v_new_row reservations%rowtype;
begin
  -- Serializes concurrent bookings for this date only.
  perform pg_advisory_xact_lock(hashtext(p_reservation_date::text));

  -- The pool: active tables NOT already held by a *placed* (table_id set)
  -- holding reservation whose window overlaps this one.
  select coalesce(array_agg(t.capacity order by t.capacity), '{}')
  into v_capacities
  from tables t
  where t.active
    and not exists (
      select 1 from reservations r
      where r.table_id = t.id
        and r.reservation_date = p_reservation_date
        and r.status in ('pending', 'confirmed')
        and r.start_time < p_end_time and p_start_time < r.end_time
    );

  -- Unplaced holding reservations overlapping this window consume capacity
  -- from that same pool (no specific table -- see migration 0045), largest
  -- party first for best-fit-decreasing, same as the Python version this
  -- replaces.
  select coalesce(array_agg(r.party_size order by r.party_size desc), '{}')
  into v_sizes
  from reservations r
  where r.reservation_date = p_reservation_date
    and r.status in ('pending', 'confirmed')
    and r.table_id is null
    and r.start_time < p_end_time and p_start_time < r.end_time;

  v_sizes := array_append(v_sizes, p_party_size);
  select coalesce(array_agg(x order by x desc), '{}') into v_sizes from unnest(v_sizes) x;

  -- Best-fit-decreasing: for each party (largest first), consume the
  -- smallest still-available table that fits it. Nulling a consumed slot
  -- (rather than removing it) keeps array indices stable across the loop.
  foreach v_size in array v_sizes loop
    v_idx := null;
    for i in 1 .. coalesce(array_length(v_capacities, 1), 0) loop
      if v_capacities[i] is not null and v_capacities[i] >= v_size then
        v_idx := i;
        exit;
      end if;
    end loop;
    if v_idx is null then
      raise exception 'NO_CAPACITY';
    end if;
    v_capacities[v_idx] := null;
  end loop;

  insert into reservations (
    table_id, party_size, reservation_date, start_time, end_time, status,
    customer_name, customer_phone, customer_note, has_advance_order
  ) values (
    null, p_party_size, p_reservation_date, p_start_time, p_end_time, 'pending',
    p_customer_name, p_customer_phone, p_customer_note, p_has_advance_order
  ) returning * into v_new_row;

  return v_new_row;
end;
$$;
