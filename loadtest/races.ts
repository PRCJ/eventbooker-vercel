/**
 * Adversarial concurrency. The main storm fires single-seat requests, which is
 * the headline scenario but also the easiest one. These are the cases that
 * actually break seat-booking services:
 *
 *   1. Overlapping multi-seat requests  -- classic lock-ordering deadlock.
 *   2. Cancel racing a reserve          -- stale release resurrecting a sold seat.
 *   3. Hold expiry racing a reserve     -- two buyers across the TTL boundary.
 *   4. One user, many parallel requests -- the per-user limit under a true race.
 *   5. Same key fired simultaneously    -- idempotency without a prior commit.
 *
 *   npx tsx loadtest/races.ts [--url http://localhost:3000] [--rounds 40]
 */
import { Client, fmt, pool } from './client.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const URL_BASE = args.get('url') ?? process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = args.get('admin') ?? process.env.ADMIN_TOKEN ?? 'dev-only-admin-token';
const ROUNDS = Number(args.get('rounds') ?? 40);
const c = new Client(URL_BASE, 512);

const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures.push(name);
}
const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function makeShow(name: string, seats: string[], opts: Record<string, unknown> = {}) {
  const r = await c.post('/shows', { name, seats, price_paise: 25_000, ...opts }, c.auth(ADMIN));
  if (r.status !== 201) throw new Error(`create show failed: ${r.status} ${r.raw.slice(0, 200)}`);
  return r.body.id as string;
}

async function main() {
  console.log(`\x1b[1mEventBooker race suite\x1b[0m  target=${URL_BASE}  rounds=${ROUNDS}\n`);

  /* ---------------------------------------------------------------- 1 */
  section('1. Overlapping multi-seat requests (deadlock bait)');
  {
    // Every request asks for 4 seats drawn from a pool of 8, in randomised
    // order. If the server locked seats in request order rather than a
    // canonical one, this deadlocks within a few hundred requests.
    const seats = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
    const showId = await makeShow(`race-multi-${uniq()}`, seats, { per_user_limit: 8 });
    const N = 600;
    const tokens = await pool(N, 64, (i) => c.token(`multi-${uniq()}-${i}`));

    const res = await pool(N, 300, async (i) => {
      const shuffled = [...seats].sort(() => Math.random() - 0.5).slice(0, 4);
      return c.post(`/shows/${showId}/reserve`, { seats: shuffled, idempotency_key: uniq() }, c.auth(tokens[i]));
    });

    const codes = new Map<number, number>();
    for (const r of res) codes.set(r.status, (codes.get(r.status) ?? 0) + 1);
    console.log(`        statuses: ${[...codes].map(([s, n]) => `${s}×${n}`).join(' ')}`);

    check('no 5xx from overlapping multi-seat requests (no deadlock surfaced)',
      ![...codes.keys()].some((s) => s >= 500));

    const deadlockish = res.filter((r) => /deadlock/i.test(r.raw)).length;
    check('no deadlock reached the client', deadlockish === 0, `${deadlockish} responses mentioned deadlock`);

    // All-or-nothing: every winner must hold exactly 4 seats, never a partial.
    const winners = res.filter((r) => r.status === 201);
    check('every multi-seat winner got all 4 seats or none',
      winners.every((r) => r.body.seats?.length === 4),
      winners.filter((r) => r.body.seats?.length !== 4).map((r) => r.body.seats?.length).join(','));

    const st = await c.get(`/shows/${showId}`);
    const owners = new Map<string, string>();
    let conflict = false;
    for (const r of winners) for (const s of r.body.seats) {
      if (owners.has(s)) conflict = true;
      owners.set(s, r.body.user_id);
    }
    check('no seat appears in two winning multi-seat reservations', !conflict);
    const k = st.body.counts;
    check('reconciliation holds after the multi-seat race',
      k.available + k.held + k.confirmed === st.body.total_seats,
      `${k.available}+${k.held}+${k.confirmed} vs ${st.body.total_seats}`);
    check('winners × 4 equals confirmed seats', winners.length * 4 === k.confirmed,
      `${winners.length}×4 vs ${k.confirmed}`);
  }

  /* ---------------------------------------------------------------- 2 */
  section('2. Cancel racing a competing reserve');
  {
    let resurrected = 0;
    let doubleOwned = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const showId = await makeShow(`race-cancel-${uniq()}`, ['X1']);
      const owner = await c.token(`owner-${uniq()}`);
      const rival = await c.token(`rival-${uniq()}`);

      const first = await c.post(`/shows/${showId}/reserve`, { seats: ['X1'], idempotency_key: uniq() }, c.auth(owner));
      if (first.status !== 201) continue;

      // Fire the owner's cancel and a rival's grab at the same instant, then
      // repeatedly cancel to try to land a release after the rival has won.
      const [, grab] = await Promise.all([
        c.post(`/reservations/${first.body.reservation_id}/cancel`, {}, c.auth(owner)),
        c.post(`/shows/${showId}/reserve`, { seats: ['X1'], idempotency_key: uniq() }, c.auth(rival)),
      ]);
      await c.post(`/reservations/${first.body.reservation_id}/cancel`, {}, c.auth(owner));
      await c.post(`/reservations/${first.body.reservation_id}/cancel`, {}, c.auth(owner));

      const st = await c.get(`/shows/${showId}`);
      const status = st.body.seats.X1;
      if (grab.status === 201 && status !== 'confirmed') resurrected++;
      const k = st.body.counts;
      if (k.available + k.held + k.confirmed !== 1) doubleOwned++;
    }
    check(`a late cancel never released a seat already sold to someone else (${ROUNDS} rounds)`,
      resurrected === 0, `${resurrected} resurrections`);
    check('reconciliation held through every cancel race', doubleOwned === 0);
  }

  /* ---------------------------------------------------------------- 3 */
  section('3. Buyers racing across a hold-expiry boundary');
  {
    const showId = await makeShow(`race-ttl-${uniq()}`, ['T1'], { hold_ttl_seconds: 1 });
    const first = await c.token(`ttl-a-${uniq()}`);
    const held = await c.post(`/shows/${showId}/reserve`, { seats: ['T1'], idempotency_key: uniq() }, c.auth(first));
    check('initial hold placed', held.status === 201 && held.body.status === 'held');

    // 200 buyers all swing at the seat right as the hold lapses.
    await new Promise((r) => setTimeout(r, 950));
    const tokens = await pool(200, 64, (i) => c.token(`ttl-${uniq()}-${i}`));
    const res = await pool(200, 200, (i) =>
      c.post(`/shows/${showId}/reserve`, { seats: ['T1'], idempotency_key: uniq() }, c.auth(tokens[i])));

    const wins = res.filter((r) => r.status === 201);
    const errs = res.filter((r) => r.status >= 500);
    check('exactly one buyer claimed the expiring seat', wins.length === 1, `${wins.length} winners`);
    check('no 5xx at the expiry boundary', errs.length === 0, `${errs.length} errors`);

    const confirmLapsed = await c.post(`/reservations/${held.body.reservation_id}/confirm`, {}, c.auth(first));
    check('the original holder cannot confirm after losing the seat', confirmLapsed.status === 409,
      `got ${confirmLapsed.status}`);
    const st = await c.get(`/shows/${showId}`);
    check('reconciliation holds across expiry', st.body.counts.available + st.body.counts.held +
      st.body.counts.confirmed === 1);
  }

  /* ---------------------------------------------------------------- 4 */
  section('4. One user, many simultaneous requests, limit of 4');
  {
    let violations = 0;
    let errors = 0;
    for (let round = 0; round < Math.min(ROUNDS, 20); round++) {
      const seats = Array.from({ length: 20 }, (_, i) => `G${i}`);
      const showId = await makeShow(`race-limit-${uniq()}`, seats, { per_user_limit: 4 });
      const tok = await c.token(`greedy-${uniq()}`);
      // 20 parallel single-seat grabs, all distinct seats, one user.
      const res = await Promise.all(seats.map((s) =>
        c.post(`/shows/${showId}/reserve`, { seats: [s], idempotency_key: uniq() }, c.auth(tok))));
      const won = res.filter((r) => r.status === 201).reduce((a, r) => a + r.body.seats.length, 0);
      if (won > 4) violations++;
      if (res.some((r) => r.status >= 500)) errors++;
    }
    check(`the per-user limit was never exceeded under a parallel race (${Math.min(ROUNDS, 20)} rounds)`,
      violations === 0, `${violations} rounds exceeded the limit`);
    check('no 5xx from the per-user-limit race', errors === 0);
  }

  /* ---------------------------------------------------------------- 5 */
  section('5. The same idempotency key fired simultaneously');
  {
    let fanout = 0;
    let extra201 = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const showId = await makeShow(`race-idem-${uniq()}`, ['K1', 'K2']);
      const tok = await c.token(`idem-${uniq()}`);
      const key = uniq();
      // 50 identical requests at once -- none of them has a committed row to
      // replay, so this is the case a naive "insert ... on conflict do nothing"
      // gets wrong.
      const res = await Promise.all(Array.from({ length: 50 }, () =>
        c.post(`/shows/${showId}/reserve`, { seats: ['K1'], idempotency_key: key }, c.auth(tok))));
      const ids = new Set(res.filter((r) => r.body?.reservation_id).map((r) => r.body.reservation_id));
      if (ids.size > 1) fanout++;
      if (res.filter((r) => r.status === 201).length > 1) extra201++;
    }
    check(`simultaneous identical retries collapse to one reservation (${ROUNDS} rounds)`, fanout === 0,
      `${fanout} rounds produced more than one reservation id`);
    check('simultaneous identical retries yield exactly one 201', extra201 === 0,
      `${extra201} rounds produced more than one 201`);
  }

  /* ---------------------------------------------------------------- */
  section('Global invariants after every race');
  {
    const m = await c.get('/metrics');
    check('/metrics still reports zero double-sold seats', /eventbooker_double_sold_seats 0\b/.test(m.raw));
    check('/metrics still reports reconciliation ok', /eventbooker_reconciliation_ok 1\b/.test(m.raw));
    const unhandled = /eventbooker_unhandled_errors_total/.test(m.raw);
    check('no unhandled server errors were recorded', !unhandled,
      m.raw.split('\n').filter((l) => l.startsWith('eventbooker_unhandled')).join(' '));
  }

  console.log(`\n${'─'.repeat(70)}`);
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} CHECK(S) FAILED\x1b[0m`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('\x1b[32mall race checks passed\x1b[0m');
  }
  c.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
