/**
 * Functional conformance suite. One check per rule the service claims to hold,
 * run over real HTTP against a real database. Concurrency is proved separately
 * by storm.ts; this file pins the deterministic semantics.
 *
 *   npx tsx loadtest/api_test.ts [--url http://localhost:3000] [--admin <secret>]
 */
import { Client } from './client.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const URL_BASE = args.get('url') ?? process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = args.get('admin') ?? process.env.ADMIN_TOKEN ?? 'dev-only-admin-token';
const c = new Client(URL_BASE, 32);

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function main() {
  const stamp = uniq();
  const seats = ['A1', 'A2', 'A3', 'A12', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1'];

  section('Show creation & admin boundary');

  const anon = await c.post('/shows', { name: `x-${stamp}`, seats, price_paise: 25000 });
  check('POST /shows without admin credentials is 403', anon.status === 403, `got ${anon.status}`);

  const created = await c.post(
    '/shows',
    { name: `fn-${stamp}`, seats, price_paise: 25000, per_user_limit: 4 },
    c.auth(ADMIN),
  );
  check('POST /shows returns 201', created.status === 201, `got ${created.status} ${created.raw.slice(0, 200)}`);
  const showId: string = created.body?.id;
  check('created show has an id', Boolean(showId));
  check('every seat starts available', created.body?.counts?.available === seats.length,
    JSON.stringify(created.body?.counts));
  check('total_seats matches the seat list', created.body?.total_seats === seats.length);

  const badPrice = await c.post('/shows', { name: 'f', seats, price_paise: 250.5 }, c.auth(ADMIN));
  check('fractional price_paise is rejected (money is integer minor units)', badPrice.status === 400,
    `got ${badPrice.status}`);

  section('Authentication & token-derived identity');

  const alice = await c.token('alice-' + stamp);
  const bob = await c.token('bob-' + stamp);

  const noAuth = await c.post(`/shows/${showId}/reserve`, { seats: ['A1'], idempotency_key: uniq() });
  check('reserve without a token is 401', noAuth.status === 401, `got ${noAuth.status}`);

  const badTok = await c.post(`/shows/${showId}/reserve`, { seats: ['A1'], idempotency_key: uniq() },
    { authorization: 'Bearer not.a.token' });
  check('reserve with a forged token is 401', badTok.status === 401, `got ${badTok.status}`);

  // The spoofing test: Bob's token, Alice's user_id in the body.
  const spoof = await c.post(
    `/shows/${showId}/reserve`,
    { seats: ['C1'], idempotency_key: uniq(), user_id: 'alice-' + stamp, sub: 'alice-' + stamp },
    c.auth(bob),
  );
  check('a spoofed user_id in the body is ignored', spoof.status === 201 && spoof.body.user_id === 'bob-' + stamp,
    `status ${spoof.status}, user_id ${spoof.body?.user_id}`);

  section('Reserve, decline, and the double-sell rule');

  const key1 = uniq();
  const r1 = await c.post(`/shows/${showId}/reserve`, { seats: ['A12'], idempotency_key: key1 }, c.auth(alice));
  check('first reserve of A12 returns 201', r1.status === 201, `got ${r1.status} ${r1.raw.slice(0, 200)}`);
  check('response carries the expected shape', Boolean(r1.body?.reservation_id) && r1.body?.status === 'confirmed'
    && Array.isArray(r1.body?.seats) && r1.body?.amount_paise === 25000,
    JSON.stringify(r1.body));

  const r2 = await c.post(`/shows/${showId}/reserve`, { seats: ['A12'], idempotency_key: uniq() }, c.auth(bob));
  check('a second user gets 409, not 500', r2.status === 409, `got ${r2.status}`);
  check('the decline names the reason', r2.body?.error?.code === 'seats_unavailable', JSON.stringify(r2.body));

  section('Idempotency');

  const replay = await c.post(`/shows/${showId}/reserve`, { seats: ['A12'], idempotency_key: key1 }, c.auth(alice));
  check('replaying the key is not an error', replay.status === 200, `got ${replay.status}`);
  check('replay returns the original reservation',
    replay.body?.reservation_id === r1.body?.reservation_id,
    `${replay.body?.reservation_id} vs ${r1.body?.reservation_id}`);
  check('replay is flagged as a replay', replay.body?.replay === true);

  const reuse = await c.post(`/shows/${showId}/reserve`, { seats: ['B1'], idempotency_key: key1 }, c.auth(alice));
  check('same key with different seats is 409', reuse.status === 409, `got ${reuse.status}`);
  check('the conflict is identified as key reuse', reuse.body?.error?.code === 'idempotency_key_reuse',
    JSON.stringify(reuse.body));

  const headerKey = uniq();
  const viaHeader = await c.post(`/shows/${showId}/reserve`, { seats: ['B2'] }, { ...c.auth(alice), 'idempotency-key': headerKey });
  check('Idempotency-Key header is accepted', viaHeader.status === 201, `got ${viaHeader.status}`);
  const viaHeader2 = await c.post(`/shows/${showId}/reserve`, { seats: ['B2'] }, { ...c.auth(alice), 'idempotency-key': headerKey });
  check('header-keyed retry replays', viaHeader2.status === 200 &&
    viaHeader2.body.reservation_id === viaHeader.body.reservation_id);

  const noKey = await c.post(`/shows/${showId}/reserve`, { seats: ['B3'] }, c.auth(alice));
  check('a missing idempotency key is a 400', noKey.status === 400, `got ${noKey.status}`);

  section('Per-user limit');

  // Alice holds A12 and B2 already; the limit is 4.
  const l3 = await c.post(`/shows/${showId}/reserve`, { seats: ['B3', 'B4'] , idempotency_key: uniq() }, c.auth(alice));
  check('alice reaches exactly her limit of 4', l3.status === 201, `got ${l3.status} ${l3.raw.slice(0, 200)}`);
  const l4 = await c.post(`/shows/${showId}/reserve`, { seats: ['B5'], idempotency_key: uniq() }, c.auth(alice));
  check('the 5th seat is declined with 409', l4.status === 409, `got ${l4.status}`);
  check('the decline names the limit', l4.body?.error?.code === 'per_user_limit_exceeded', JSON.stringify(l4.body));

  section('Partial requests (documented behaviour: all-or-nothing)');

  const carol = await c.token('carol-' + stamp);
  const mixed = await c.post(`/shows/${showId}/reserve`, { seats: ['A1', 'A12'], idempotency_key: uniq() }, c.auth(carol));
  check('asking for one free + one taken seat is declined', mixed.status === 409, `got ${mixed.status}`);
  check('the decline lists which seats blocked it',
    Array.isArray(mixed.body?.error?.unavailable_seats) && mixed.body.error.unavailable_seats.includes('A12'),
    JSON.stringify(mixed.body?.error));

  const stateAfter = await c.get(`/shows/${showId}`);
  check('the free seat in a failed all-or-nothing request was NOT taken',
    stateAfter.body?.seats?.A1 === 'available', `A1 is ${stateAfter.body?.seats?.A1}`);

  const best = await c.post(`/shows/${showId}/reserve`,
    { seats: ['A1', 'A12'], idempotency_key: uniq(), mode: 'best_effort' }, c.auth(carol));
  check('opt-in best_effort mode takes what it can', best.status === 201 && best.body?.seats?.length === 1,
    JSON.stringify(best.body));
  check('best_effort flags the partial fill', best.body?.partial === true);

  section('Cancellation & ownership');

  const mallory = await c.token('mallory-' + stamp);
  const steal = await c.post(`/reservations/${r1.body.reservation_id}/cancel`, {}, c.auth(mallory));
  check('a stranger cannot cancel your reservation', steal.status === 403 || steal.status === 404,
    `got ${steal.status}`);

  const readSomeoneElse = await c.get(`/reservations/${r1.body.reservation_id}`, c.auth(mallory));
  check('a stranger cannot read your reservation', readSomeoneElse.status === 404, `got ${readSomeoneElse.status}`);

  const cancelled = await c.post(`/reservations/${r1.body.reservation_id}/cancel`, {}, c.auth(alice));
  check('the owner can cancel', cancelled.status === 200, `got ${cancelled.status} ${cancelled.raw.slice(0, 200)}`);
  check('cancellation reports the released seat', cancelled.body?.released_seats === 1, JSON.stringify(cancelled.body));

  const rebook = await c.post(`/shows/${showId}/reserve`, { seats: ['A12'], idempotency_key: uniq() }, c.auth(bob));
  check('a released seat is cleanly re-bookable by someone else', rebook.status === 201, `got ${rebook.status}`);

  const lateCancel = await c.post(`/reservations/${r1.body.reservation_id}/cancel`, {}, c.auth(alice));
  check('cancelling twice is idempotent, not an error', lateCancel.status === 200, `got ${lateCancel.status}`);
  const stillBobs = await c.get(`/shows/${showId}`);
  check('the stale cancel did NOT resurrect a seat now owned by someone else',
    stillBobs.body?.seats?.A12 === 'confirmed', `A12 is ${stillBobs.body?.seats?.A12}`);

  section('Time-boxed holds & expiry');

  // Two shows on purpose. Observing a hold and watching one lapse need
  // opposite TTLs, and sharing one short TTL makes the "is it held?" checks
  // fail on any environment where a round trip takes longer than the hold
  // (vercel dev, or any remote target).
  const holdShow = await c.post('/shows',
    { name: `hold-${stamp}`, seats: ['H1'], price_paise: 10000, hold_ttl_seconds: 600 }, c.auth(ADMIN));
  const hid = holdShow.body.id;
  const held = await c.post(`/shows/${hid}/reserve`, { seats: ['H1'], idempotency_key: uniq() }, c.auth(alice));
  check('reserve on a hold-mode show returns status held', held.status === 201 && held.body?.status === 'held',
    `${held.status} ${JSON.stringify(held.body)}`);

  const whileHeld = await c.post(`/shows/${hid}/reserve`, { seats: ['H1'], idempotency_key: uniq() }, c.auth(bob));
  check('an active hold blocks another buyer', whileHeld.status === 409, `got ${whileHeld.status}`);

  const duringState = await c.get(`/shows/${hid}`);
  check('a held seat reports as held', duringState.body?.seats?.H1 === 'held', JSON.stringify(duringState.body?.counts));

  const confirmed = await c.post(`/reservations/${held.body.reservation_id}/confirm`, {}, c.auth(alice));
  check('the owner can convert a hold into a confirmation', confirmed.status === 200 &&
    confirmed.body?.status === 'confirmed', `${confirmed.status} ${confirmed.raw.slice(0, 160)}`);

  // Separate short-TTL show for the expiry half.
  const expiryShow = await c.post('/shows',
    { name: `expire-${stamp}`, seats: ['H2'], price_paise: 10000, hold_ttl_seconds: 2 }, c.auth(ADMIN));
  const eid = expiryShow.body.id;
  const held2 = await c.post(`/shows/${eid}/reserve`, { seats: ['H2'], idempotency_key: uniq() }, c.auth(alice));
  check('second hold placed', held2.status === 201, `got ${held2.status}`);
  console.log('        waiting 2.5s for the hold to lapse…');
  await new Promise((r) => setTimeout(r, 2500));

  const afterExpiry = await c.get(`/shows/${eid}`);
  check('a lapsed hold reads as available without any sweeper running',
    afterExpiry.body?.seats?.H2 === 'available', `H2 is ${afterExpiry.body?.seats?.H2}`);
  const grabExpired = await c.post(`/shows/${eid}/reserve`, { seats: ['H2'], idempotency_key: uniq() }, c.auth(bob));
  check('another buyer can take the expired seat', grabExpired.status === 201, `got ${grabExpired.status}`);
  const lateConfirm = await c.post(`/reservations/${held2.body.reservation_id}/confirm`, {}, c.auth(alice));
  check('confirming a lapsed hold is refused, not honoured', lateConfirm.status === 409, `got ${lateConfirm.status}`);

  section('Show state & reconciliation');

  const st = await c.get(`/shows/${showId}`);
  const k = st.body.counts;
  check('available + held + confirmed == total_seats',
    k.available + k.held + k.confirmed === st.body.total_seats,
    `${k.available}+${k.held}+${k.confirmed} != ${st.body.total_seats}`);
  check('per-seat statuses are reported', Object.keys(st.body.seats ?? {}).length === seats.length);

  const inv = await c.get(`/shows/${showId}/invariant`);
  check('GET /shows/{id}/invariant says it holds', inv.body?.holds === true, JSON.stringify(inv.body));
  check('seat rows and reservation rows agree', inv.body?.seat_ledger_agrees === true, JSON.stringify(inv.body));

  section('Input validation (bad input is 4xx, never 5xx)');

  const cases: Array<[string, Promise<any>]> = [
    ['unknown show id', c.post(`/shows/00000000-0000-0000-0000-000000000000/reserve`,
      { seats: ['A1'], idempotency_key: uniq() }, c.auth(alice))],
    ['non-uuid show id', c.post(`/shows/not-a-uuid/reserve`, { seats: ['A1'], idempotency_key: uniq() }, c.auth(alice))],
    ['unknown seat label', c.post(`/shows/${showId}/reserve`, { seats: ['ZZ99'], idempotency_key: uniq() }, c.auth(alice))],
    ['empty seat array', c.post(`/shows/${showId}/reserve`, { seats: [], idempotency_key: uniq() }, c.auth(alice))],
    ['seats not an array', c.post(`/shows/${showId}/reserve`, { seats: 'A1', idempotency_key: uniq() }, c.auth(alice))],
    ['non-string seat', c.post(`/shows/${showId}/reserve`, { seats: [42], idempotency_key: uniq() }, c.auth(alice))],
    ['too many seats', c.post(`/shows/${showId}/reserve`,
      { seats: Array.from({ length: 50 }, (_, i) => `A${i}`), idempotency_key: uniq() }, c.auth(alice))],
    ['unknown reservation', c.post(`/reservations/00000000-0000-0000-0000-000000000000/cancel`, {}, c.auth(alice))],
  ];
  for (const [name, p] of cases) {
    const res = await p;
    check(`${name} -> 4xx (got ${res.status})`, res.status >= 400 && res.status < 500);
  }

  const malformed = await c.request('POST', `/shows/${showId}/reserve`, undefined,
    { ...c.auth(alice), 'content-type': 'application/json' });
  check('empty body is 4xx', malformed.status >= 400 && malformed.status < 500, `got ${malformed.status}`);

  section('Observability endpoints');

  const health = await c.get('/healthz');
  check('GET /healthz is 200', health.status === 200);
  const ready = await c.get('/readyz');
  check('GET /readyz reports ready', ready.status === 200 && ready.body?.status === 'ready');
  const metrics = await c.get('/metrics');
  check('GET /metrics serves Prometheus text', metrics.status === 200 && metrics.raw.includes('eventbooker_'));
  check('/metrics publishes the double-sell gauge', metrics.raw.includes('eventbooker_double_sold_seats 0'),
    'gauge missing or non-zero');
  check('/metrics publishes the reconciliation gauge', metrics.raw.includes('eventbooker_reconciliation_ok 1'));
  const live = await c.get(`/api/live?show_id=${showId}`);
  check('GET /api/live backs the dashboard', live.status === 200 && Array.isArray(live.body?.shows));
  const dash = await c.get('/');
  check('GET / serves the dashboard', dash.status === 200 && dash.raw.includes('EventBooker'));

  console.log(`\n${'─'.repeat(64)}`);
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} FAILED\x1b[0m, ${passed} passed`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32mall ${passed} checks passed\x1b[0m`);
  }
  c.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
