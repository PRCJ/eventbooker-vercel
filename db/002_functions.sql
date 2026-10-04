-- All state transitions live here, in the database, as single round trips.
--
-- Lock order is global and never varies, which is why none of this deadlocks:
--     1. the reservations row for (user_id, idempotency_key)
--     2. an advisory lock on (show_id, user_id)
--     3. seat rows, always ascending by label
--
-- Two different users never contend on step 2, and step 3 is sorted, so there is
-- no cycle for two transactions to get stuck in.

create or replace function reservation_json(r reservations)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'reservation_id', r.id,
    'show_id',        r.show_id,
    'user_id',        r.user_id,
    'seats',          to_jsonb(r.seats),
    'amount_paise',   r.amount_paise,
    'status',         r.status,
    'created_at',     r.created_at,
    'expires_at',     r.expires_at
  );
$$;


create or replace function reserve_seats(
  p_show_id   uuid,
  p_user_id   text,
  p_seats     text[],
  p_idem_key  text,
  p_fingerprint text
) returns jsonb
language plpgsql
as $$
declare
  v_show       shows%rowtype;
  v_res        reservations%rowtype;
  v_res_id     uuid;
  v_inserted   boolean;
  v_norm       text[];
  v_want       int;
  v_found      int;
  v_taken      text[];
  v_acquired   text[];
  v_held_count int;
  v_amount     bigint;
  v_status     text;
  v_expires    timestamptz;
  v_seat_state seat_status;
begin
  -- Normalise: dedupe + sort. Dedupe stops a request from fighting itself;
  -- sorting is what makes the multi-seat lock order deterministic.
  select array_agg(distinct x order by x) into v_norm from unnest(p_seats) as t(x) where x is not null and x <> '';
  v_want := coalesce(cardinality(v_norm), 0);

  if v_want = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request', 'message', 'no seats requested');
  end if;

  select * into v_show from shows where id = p_show_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'show_not_found', 'message', 'show does not exist');
  end if;

  ------------------------------------------------------------------
  -- 1. Claim the idempotency key.
  --
  -- ON CONFLICT DO UPDATE (not DO NOTHING) on purpose: DO NOTHING does not block
  -- on a concurrent uncommitted insert of the same key, so a simultaneous retry
  -- would slip through and get neither the row nor a conflict. DO UPDATE takes
  -- the row lock, waits for the first transaction, and then hands us the winner.
  -- xmax = 0 is how we tell "I inserted it" from "I collided with it".
  ------------------------------------------------------------------
  insert into reservations (show_id, user_id, status, decline_reason, seats, amount_paise,
                            idempotency_key, request_fingerprint)
  values (p_show_id, p_user_id, 'declined', 'processing', v_norm, 0, p_idem_key, p_fingerprint)
  on conflict (user_id, idempotency_key)
    do update set replay_count = reservations.replay_count + 1
  returning id, (xmax = 0) into v_res_id, v_inserted;

  if not v_inserted then
    select * into v_res from reservations where id = v_res_id;

    -- Same key, different request => the client has a bug. Never silently
    -- serve them someone else's seats.
    if v_res.request_fingerprint is distinct from p_fingerprint then
      return jsonb_build_object(
        'ok', false, 'code', 'idempotency_key_reuse',
        'message', 'this idempotency key was already used with a different request body',
        'original', reservation_json(v_res));
    end if;

    -- Honest replay: return the original outcome verbatim, win or lose.
    if v_res.status = 'declined' then
      return jsonb_build_object('ok', false, 'replay', true,
                                'code', coalesce(v_res.decline_reason, 'seats_unavailable'),
                                'message', 'replay of an earlier declined request',
                                'reservation', reservation_json(v_res));
    end if;
    return jsonb_build_object('ok', true, 'replay', true, 'reservation', reservation_json(v_res));
  end if;

  ------------------------------------------------------------------
  -- 2. Per-user limit, serialised per (show, user).
  --
  -- Without this lock, ten parallel requests from one user each read "0 held"
  -- and each take a seat. The lock is scoped to the user, so it costs other
  -- buyers nothing -- 500 strangers storming A12 never touch it.
  ------------------------------------------------------------------
  perform pg_advisory_xact_lock(hashtextextended(p_show_id::text || '|' || p_user_id, 0));

  select count(*) into v_held_count
    from seats
   where show_id = p_show_id
     and holder_user_id = p_user_id
     and not seat_is_free(status, held_until);

  if v_held_count + v_want > v_show.per_user_limit then
    update reservations
       set status = 'declined', decline_reason = 'per_user_limit_exceeded'
     where id = v_res_id returning * into v_res;
    return jsonb_build_object(
      'ok', false, 'code', 'per_user_limit_exceeded',
      'message', format('user already holds %s of %s allowed seats for this show',
                        v_held_count, v_show.per_user_limit),
      'held', v_held_count, 'limit', v_show.per_user_limit,
      'reservation', reservation_json(v_res));
  end if;

  ------------------------------------------------------------------
  -- 3. Acquire the seats. All-or-nothing.
  ------------------------------------------------------------------
  if v_show.hold_ttl_seconds > 0 then
    v_seat_state := 'held';
    v_status     := 'held';
    v_expires    := now() + make_interval(secs => v_show.hold_ttl_seconds);
  else
    v_seat_state := 'confirmed';
    v_status     := 'confirmed';
    v_expires    := null;
  end if;

  select count(*) into v_found from seats where show_id = p_show_id and label = any(v_norm);
  if v_found <> v_want then
    update reservations
       set status = 'declined', decline_reason = 'unknown_seats'
     where id = v_res_id returning * into v_res;
    return jsonb_build_object('ok', false, 'code', 'unknown_seats',
                              'message', 'one or more seats do not exist in this show',
                              'reservation', reservation_json(v_res));
  end if;

  if v_want > 1 then
    -- Multi-seat: take every row lock up front, ascending, before deciding
    -- anything. Under READ COMMITTED the next statement gets a fresh snapshot,
    -- so once we hold these locks we are reading the truth and nobody can move
    -- underneath us.
    perform label from seats
      where show_id = p_show_id and label = any(v_norm)
      order by label
      for update;

    select array_agg(label order by label) into v_taken
      from seats
     where show_id = p_show_id and label = any(v_norm)
       and not seat_is_free(status, held_until);

    if v_taken is not null then
      update reservations
         set status = 'declined', decline_reason = 'seats_unavailable'
       where id = v_res_id returning * into v_res;
      return jsonb_build_object('ok', false, 'code', 'seats_unavailable',
                                'message', 'one or more requested seats are already taken',
                                'unavailable_seats', to_jsonb(v_taken),
                                'reservation', reservation_json(v_res));
    end if;
  end if;

  -- The atomic decision. The WHERE clause is the guard: a row that someone else
  -- confirmed a microsecond ago no longer matches, so it is simply not returned.
  -- Under READ COMMITTED, a concurrent writer makes this UPDATE re-check the
  -- predicate against the *new* row version, which is exactly the behaviour that
  -- makes a read-then-write race impossible here.
  with claimed as (
    update seats
       set status         = v_seat_state,
           reservation_id = v_res_id,
           holder_user_id = p_user_id,
           held_until     = v_expires,
           updated_at     = now()
     where show_id = p_show_id
       and label = any(v_norm)
       and seat_is_free(status, held_until)
    returning label
  )
  select array_agg(label order by label) into v_acquired from claimed;

  if coalesce(cardinality(v_acquired), 0) <> v_want then
    -- The single-seat path lands here when it loses the race, having changed
    -- nothing. The multi-seat path proved availability while holding the row
    -- locks and so cannot land here at all -- but if it ever did, handing back
    -- whatever we grabbed is the difference between a decline and a leaked seat.
    update seats
       set status = 'available', reservation_id = null, holder_user_id = null,
           held_until = null, updated_at = now()
     where show_id = p_show_id and reservation_id = v_res_id;

    update reservations
       set status = 'declined', decline_reason = 'seats_unavailable'
     where id = v_res_id returning * into v_res;
    return jsonb_build_object('ok', false, 'code', 'seats_unavailable',
                              'message', 'one or more requested seats are already taken',
                              'unavailable_seats', to_jsonb(v_norm),
                              'reservation', reservation_json(v_res));
  end if;

  v_amount := v_show.price_paise * v_want;

  update reservations
     set status = v_status, decline_reason = null, amount_paise = v_amount, expires_at = v_expires
   where id = v_res_id returning * into v_res;

  -- One capture per reservation, enforced by UNIQUE(reservation_id). A retry
  -- cannot reach here at all (it replayed at step 1), and even if it did the
  -- constraint would stop a second charge.
  if v_status = 'confirmed' then
    insert into payments (reservation_id, user_id, amount_paise, status)
    values (v_res_id, p_user_id, v_amount, 'captured')
    on conflict (reservation_id) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'replay', false, 'reservation', reservation_json(v_res));
end;
$$;


-- Partial-grab semantics are all-or-nothing, but a caller who would rather take
-- what is left can ask for it explicitly. Same guards, same lock order.
create or replace function reserve_seats_best_effort(
  p_show_id uuid, p_user_id text, p_seats text[], p_idem_key text, p_fingerprint text
) returns jsonb
language plpgsql as $$
declare
  v_show shows%rowtype; v_res reservations%rowtype; v_res_id uuid; v_inserted boolean;
  v_norm text[]; v_free text[]; v_acquired text[]; v_held_count int; v_room int; v_amount bigint;
  v_status text; v_seat_state seat_status; v_expires timestamptz;
begin
  select array_agg(distinct x order by x) into v_norm from unnest(p_seats) as t(x) where x is not null and x <> '';
  if coalesce(cardinality(v_norm), 0) = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request', 'message', 'no seats requested');
  end if;

  select * into v_show from shows where id = p_show_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'show_not_found', 'message', 'show does not exist');
  end if;

  insert into reservations (show_id, user_id, status, decline_reason, seats, amount_paise,
                            idempotency_key, request_fingerprint)
  values (p_show_id, p_user_id, 'declined', 'processing', v_norm, 0, p_idem_key, p_fingerprint)
  on conflict (user_id, idempotency_key)
    do update set replay_count = reservations.replay_count + 1
  returning id, (xmax = 0) into v_res_id, v_inserted;

  if not v_inserted then
    select * into v_res from reservations where id = v_res_id;
    if v_res.request_fingerprint is distinct from p_fingerprint then
      return jsonb_build_object('ok', false, 'code', 'idempotency_key_reuse',
        'message', 'this idempotency key was already used with a different request body',
        'original', reservation_json(v_res));
    end if;
    if v_res.status = 'declined' then
      return jsonb_build_object('ok', false, 'replay', true,
        'code', coalesce(v_res.decline_reason, 'seats_unavailable'),
        'message', 'replay of an earlier declined request',
        'reservation', reservation_json(v_res));
    end if;
    return jsonb_build_object('ok', true, 'replay', true, 'reservation', reservation_json(v_res));
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_show_id::text || '|' || p_user_id, 0));

  select count(*) into v_held_count from seats
   where show_id = p_show_id and holder_user_id = p_user_id and not seat_is_free(status, held_until);

  v_room := v_show.per_user_limit - v_held_count;
  if v_room <= 0 then
    update reservations set status = 'declined', decline_reason = 'per_user_limit_exceeded'
     where id = v_res_id returning * into v_res;
    return jsonb_build_object('ok', false, 'code', 'per_user_limit_exceeded',
      'message', 'user is already at the per-show seat limit',
      'held', v_held_count, 'limit', v_show.per_user_limit,
      'reservation', reservation_json(v_res));
  end if;

  if v_show.hold_ttl_seconds > 0 then
    v_seat_state := 'held'; v_status := 'held';
    v_expires := now() + make_interval(secs => v_show.hold_ttl_seconds);
  else
    v_seat_state := 'confirmed'; v_status := 'confirmed'; v_expires := null;
  end if;

  -- Lock the candidates in order, then take at most v_room of the free ones.
  perform label from seats
    where show_id = p_show_id and label = any(v_norm) order by label for update;

  select array_agg(label order by label) into v_free from (
    select label from seats
     where show_id = p_show_id and label = any(v_norm) and seat_is_free(status, held_until)
     order by label limit v_room
  ) s;

  if v_free is null then
    update reservations set status = 'declined', decline_reason = 'seats_unavailable'
     where id = v_res_id returning * into v_res;
    return jsonb_build_object('ok', false, 'code', 'seats_unavailable',
      'message', 'none of the requested seats are available',
      'reservation', reservation_json(v_res));
  end if;

  with claimed as (
    update seats set status = v_seat_state, reservation_id = v_res_id, holder_user_id = p_user_id,
                     held_until = v_expires, updated_at = now()
     where show_id = p_show_id and label = any(v_free) and seat_is_free(status, held_until)
    returning label
  )
  select array_agg(label order by label) into v_acquired from claimed;

  v_amount := v_show.price_paise * coalesce(cardinality(v_acquired), 0);

  update reservations
     set status = v_status, decline_reason = null, seats = v_acquired,
         amount_paise = v_amount, expires_at = v_expires
   where id = v_res_id returning * into v_res;

  if v_status = 'confirmed' then
    insert into payments (reservation_id, user_id, amount_paise, status)
    values (v_res_id, p_user_id, v_amount, 'captured')
    on conflict (reservation_id) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'replay', false, 'partial',
                            cardinality(v_acquired) < cardinality(v_norm),
                            'reservation', reservation_json(v_res));
end;
$$;


create or replace function cancel_reservation(p_res_id uuid, p_user_id text)
returns jsonb language plpgsql as $$
declare v_res reservations%rowtype; v_freed int;
begin
  select * into v_res from reservations where id = p_res_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'reservation_not_found', 'message', 'no such reservation');
  end if;

  -- Ownership is checked against the token-derived user, never a body field.
  if v_res.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
                              'message', 'you may only cancel your own reservations');
  end if;

  if v_res.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'already', true, 'reservation', reservation_json(v_res));
  end if;
  if v_res.status not in ('held', 'confirmed') then
    return jsonb_build_object('ok', false, 'code', 'not_cancellable',
                              'message', format('reservation is %s', v_res.status),
                              'reservation', reservation_json(v_res));
  end if;

  -- `reservation_id = p_res_id` is the guard that stops a late cancel from
  -- resurrecting a seat that has since been sold to someone else: if the seat
  -- moved on, it no longer points at this reservation and is left alone.
  with freed as (
    update seats
       set status = 'available', reservation_id = null, holder_user_id = null,
           held_until = null, updated_at = now()
     where show_id = v_res.show_id and reservation_id = p_res_id
    returning label
  )
  select count(*) into v_freed from freed;

  update payments set status = 'refunded', updated_at = now()
   where reservation_id = p_res_id and status = 'captured';

  update reservations set status = 'cancelled', expires_at = null
   where id = p_res_id returning * into v_res;

  return jsonb_build_object('ok', true, 'released_seats', v_freed, 'reservation', reservation_json(v_res));
end;
$$;


create or replace function confirm_reservation(p_res_id uuid, p_user_id text)
returns jsonb language plpgsql as $$
declare v_res reservations%rowtype; v_promoted int;
begin
  select * into v_res from reservations where id = p_res_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'reservation_not_found', 'message', 'no such reservation');
  end if;
  if v_res.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'forbidden',
                              'message', 'you may only confirm your own reservations');
  end if;
  if v_res.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'already', true, 'reservation', reservation_json(v_res));
  end if;
  if v_res.status <> 'held' then
    return jsonb_build_object('ok', false, 'code', 'not_confirmable',
                              'message', format('reservation is %s', v_res.status),
                              'reservation', reservation_json(v_res));
  end if;
  if v_res.expires_at is not null and v_res.expires_at <= now() then
    perform expire_holds(v_res.show_id);
    update reservations set status = 'expired' where id = p_res_id returning * into v_res;
    return jsonb_build_object('ok', false, 'code', 'hold_expired',
                              'message', 'the hold lapsed before it was confirmed',
                              'reservation', reservation_json(v_res));
  end if;

  with promoted as (
    update seats set status = 'confirmed', held_until = null, updated_at = now()
     where show_id = v_res.show_id and reservation_id = p_res_id and status = 'held'
       and held_until > now()
    returning label
  )
  select count(*) into v_promoted from promoted;

  if v_promoted <> cardinality(v_res.seats) then
    return jsonb_build_object('ok', false, 'code', 'hold_expired',
                              'message', 'the hold lapsed before it was confirmed');
  end if;

  update reservations set status = 'confirmed', expires_at = null
   where id = p_res_id returning * into v_res;

  insert into payments (reservation_id, user_id, amount_paise, status)
  values (p_res_id, v_res.user_id, v_res.amount_paise, 'captured')
  on conflict (reservation_id) do nothing;

  return jsonb_build_object('ok', true, 'reservation', reservation_json(v_res));
end;
$$;


-- Physically reclaim lapsed holds. Reads already treat them as free via
-- seat_is_free(), so this is bookkeeping, not correctness -- which is why it is
-- safe to run it opportunistically from a cron or a request.
create or replace function expire_holds(p_show_id uuid default null)
returns int language plpgsql as $$
declare v_count int;
begin
  with lapsed as (
    update seats
       set status = 'available', reservation_id = null, holder_user_id = null,
           held_until = null, updated_at = now()
     where status = 'held' and held_until <= now()
       and (p_show_id is null or show_id = p_show_id)
    returning reservation_id
  )
  select count(*) into v_count from lapsed;

  update reservations set status = 'expired'
   where status = 'held' and expires_at is not null and expires_at <= now()
     and (p_show_id is null or show_id = p_show_id);

  return v_count;
end;
$$;


-- The reconciliation view. Counts are derived from the seat rows themselves with
-- the same effective-status rule the writer uses, so available+held+confirmed
-- cannot drift from total_seats even mid-burst.
create or replace function show_state(p_show_id uuid, p_include_seats boolean default true)
returns jsonb language plpgsql stable as $$
declare v_show shows%rowtype; v_counts jsonb; v_seats jsonb; v_total int;
begin
  select * into v_show from shows where id = p_show_id;
  if not found then return null; end if;

  select jsonb_build_object(
           'available', count(*) filter (where seat_effective_status(status, held_until) = 'available'),
           'held',      count(*) filter (where seat_effective_status(status, held_until) = 'held'),
           'confirmed', count(*) filter (where seat_effective_status(status, held_until) = 'confirmed')),
         count(*)
    into v_counts, v_total
    from seats where show_id = p_show_id;

  if p_include_seats then
    select jsonb_object_agg(label, seat_effective_status(status, held_until))
      into v_seats from seats where show_id = p_show_id;
  end if;

  return jsonb_build_object(
    'id', v_show.id,
    'name', v_show.name,
    'price_paise', v_show.price_paise,
    'per_user_limit', v_show.per_user_limit,
    'hold_ttl_seconds', v_show.hold_ttl_seconds,
    'total_seats', v_total,
    'counts', v_counts,
    'seats', coalesce(v_seats, 'null'::jsonb),
    'reconciliation', jsonb_build_object(
      'sum', (v_counts->>'available')::int + (v_counts->>'held')::int + (v_counts->>'confirmed')::int,
      'total_seats', v_total,
      'holds',
        (v_counts->>'available')::int + (v_counts->>'held')::int + (v_counts->>'confirmed')::int = v_total),
    'created_at', v_show.created_at);
end;
$$;


create or replace function create_show(
  p_name text, p_seats text[], p_price_paise bigint,
  p_per_user_limit int default 4, p_hold_ttl_seconds int default 0
) returns jsonb language plpgsql as $$
declare v_id uuid; v_norm text[]; v_n int;
begin
  select array_agg(distinct x order by x) into v_norm from unnest(p_seats) as t(x) where x is not null and x <> '';
  v_n := coalesce(cardinality(v_norm), 0);
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request', 'message', 'a show needs at least one seat');
  end if;

  insert into shows (name, price_paise, per_user_limit, hold_ttl_seconds, total_seats)
  values (p_name, p_price_paise, p_per_user_limit, p_hold_ttl_seconds, v_n)
  returning id into v_id;

  insert into seats (show_id, label) select v_id, unnest(v_norm);

  return jsonb_build_object('ok', true, 'show', show_state(v_id, true));
end;
$$;
