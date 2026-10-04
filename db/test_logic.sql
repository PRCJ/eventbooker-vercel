-- Single-session behaviour checks for the SQL layer. Concurrency is proved
-- separately by loadtest/; this file pins down the deterministic rules.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

begin;

create temporary table t (show_id uuid) on commit drop;
insert into t
select (create_show('t-show', array['A1','A2','A3','A12','B1'], 25000, 4, 0) -> 'show' ->> 'id')::uuid;

\set q 'select show_id from t'

-- 1. plain reserve wins
select 'reserve wins: ' ||
  ((reserve_seats((select show_id from t), 'alice', array['A12'], 'k1', 'fp1') ->> 'ok'));

-- 2. a second user loses the same seat cleanly
select 'contender declined: ' ||
  (reserve_seats((select show_id from t), 'bob', array['A12'], 'k2', 'fp2') ->> 'code');

-- 3. same key + same body replays the original reservation
select 'replay is same reservation: ' ||
  ((reserve_seats((select show_id from t), 'alice', array['A12'], 'k1', 'fp1') -> 'reservation' ->> 'status')
   || '/replay=' ||
   (reserve_seats((select show_id from t), 'alice', array['A12'], 'k1', 'fp1') ->> 'replay'));

-- 4. same key + different body is rejected
select 'key reuse rejected: ' ||
  (reserve_seats((select show_id from t), 'alice', array['A1'], 'k1', 'fp-different') ->> 'code');

-- 5. exactly one payment captured for alice
select 'payments for alice: ' || count(*) from payments where user_id = 'alice' and status = 'captured';

-- 6. per-user limit (alice has 1 of 4; asking for 4 more must decline)
select 'over limit: ' ||
  (reserve_seats((select show_id from t), 'alice', array['A1','A2','A3','B1'], 'k3', 'fp3') ->> 'code');

-- 7. all-or-nothing: A12 is gone, so A1+A12 takes neither
select 'all or nothing: ' ||
  (reserve_seats((select show_id from t), 'carol', array['A1','A12'], 'k4', 'fp4') ->> 'code');
select 'A1 still available: ' ||
  (seat_effective_status(status, held_until))::text from seats where show_id = (select show_id from t) and label = 'A1';

-- 8. best-effort variant takes what it can
select 'best effort partial: ' ||
  (reserve_seats_best_effort((select show_id from t), 'dave', array['A1','A12'], 'k5', 'fp5') ->> 'partial');

-- 9. cancel is owner-only
select 'stranger cannot cancel: ' ||
  (cancel_reservation(
     (select id from reservations where user_id='alice' and status='confirmed' limit 1), 'mallory') ->> 'code');

-- 10. owner can cancel and the seat returns to the pool
select 'owner cancels: ' ||
  (cancel_reservation(
     (select id from reservations where user_id='alice' and status='confirmed' limit 1), 'alice') ->> 'ok');
select 'A12 rebookable: ' ||
  (seat_effective_status(status, held_until))::text from seats where show_id = (select show_id from t) and label = 'A12';

-- 11. refund recorded, not a second charge
select 'alice refunded: ' || count(*) from payments where user_id='alice' and status='refunded';

-- 12. reconciliation holds
select 'reconciled: ' || (show_state((select show_id from t), false) -> 'reconciliation' ->> 'holds');

rollback;
