/**
 * The stampede. Fires a burst of concurrent reservations at a fresh show, with
 * a deliberate pile-up on a handful of "good" seats, then audits the result
 * against every rule on the correctness bar.
 *
 *   npx tsx loadtest/storm.ts --requests 20000 --concurrency 400
 *   npx tsx loadtest/storm.ts --url https://your.app --requests 5000
 *
 * The audit is the point. Throughput numbers are reported, but a fast service
 * that sells A12 twice has failed.
 */
import { Client, fmt, isEdgeBlocked, percentile, pool } from './client.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const num = (k: string, d: number) => Number(args.get(k) ?? d);

const URL_BASE = args.get('url') ?? process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = args.get('admin') ?? process.env.ADMIN_TOKEN ?? 'dev-only-admin-token';
const REQUESTS = num('requests', 20_000);
const CONCURRENCY = num('concurrency', 400);
const HOT_SEATS = num('hot-seats', 5);
const HALL = num('hall', 2_000);
const USERS = num('users', 4_000);
const PER_USER_LIMIT = num('limit', 4);
const RETRY_RATE = Number(args.get('retry-rate') ?? 0.1); // share of requests that replay a previous key
const HOT_SHARE = Number(args.get('hot-share') ?? 0.7); // share of buyers fighting over the hot seats

const c = new Client(URL_BASE, CONCURRENCY + 32);

const failures: string[] = [];
const notes: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const seatLabel = (i: number) => `${String.fromCharCode(65 + Math.floor(i / 50))}${(i % 50) + 1}`;

interface Outcome {
  status: number;
  code?: string;
  seats?: string[];
  reservationId?: string;
  userId: string;
  key: string;
  requested: string[];
  replay?: boolean;
  ms: number;
}

async function main() {
  console.log(`\x1b[1mEventBooker storm\x1b[0m  target=${URL_BASE}`);
  console.log(`  ${fmt(REQUESTS)} requests · ${CONCURRENCY} concurrent · hall of ${fmt(HALL)} · ` +
              `${fmt(USERS)} buyers · ${HOT_SEATS} hot seats · limit ${PER_USER_LIMIT}\n`);

  // ---------------------------------------------------------------- setup
  const seats = Array.from({ length: HALL }, (_, i) => seatLabel(i));
  const stamp = `${Date.now().toString(36)}`;
  const created = await c.post('/shows',
    { name: `storm-${stamp}`, seats, price_paise: 25_000, per_user_limit: PER_USER_LIMIT }, c.auth(ADMIN));
  if (created.status !== 201) throw new Error(`could not create show: ${created.status} ${created.raw.slice(0, 300)}`);
  const showId: string = created.body.id;
  console.log(`show ${showId} created with ${fmt(created.body.total_seats)} seats`);

  // Hot seats are the ones everyone wants.
  const hot = seats.slice(0, HOT_SEATS);
  console.log(`minting ${fmt(USERS)} buyer tokens…`);
  const tokens = await pool(USERS, 64, (i) => c.token(`storm-${stamp}-u${i}`));

  // ------------------------------------------------------- plan the burst
  // Built up front so the burst itself is pure I/O and the client is not
  // competing with itself to generate work.
  interface Job { userIdx: number; seats: string[]; key: string }
  const jobs: Job[] = [];
  const issuedKeys: Array<{ userIdx: number; seats: string[]; key: string }> = [];

  for (let i = 0; i < REQUESTS; i++) {
    // A tenth of the traffic is a retry of an already-issued key: the client
    // timed out, the user double-clicked, the proxy replayed it.
    if (issuedKeys.length > 0 && Math.random() < RETRY_RATE) {
      const prior = issuedKeys[Math.floor(Math.random() * issuedKeys.length)];
      jobs.push({ userIdx: prior.userIdx, seats: prior.seats, key: prior.key });
      continue;
    }
    const userIdx = Math.floor(Math.random() * USERS);
    // Most buyers fight over the hot seats; the rest spread across the hall.
    const wantsHot = Math.random() < HOT_SHARE;
    const want = wantsHot
      ? [hot[Math.floor(Math.random() * hot.length)]]
      : [seats[HOT_SEATS + Math.floor(Math.random() * (HALL - HOT_SEATS))]];
    const key = `k-${stamp}-${i}`;
    const job = { userIdx, seats: want, key };
    jobs.push(job);
    if (issuedKeys.length < 5_000) issuedKeys.push(job);
  }

  // A dedicated user who will fire 10 parallel requests for distinct seats on a
  // limit-of-4 show. This is the per-user-limit race, isolated.
  const greedyToken = await c.token(`storm-${stamp}-greedy`);
  const greedySeats = seats.slice(HALL - 10);

  // ---------------------------------------------------- invariant watcher
  // Polls while the burst is in flight. The invariant must hold *during* the
  // storm, not merely once the dust settles.
  const duringChecks: Array<{ sum: number; total: number; ok: boolean }> = [];
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      try {
        const r = await c.get(`/shows/${showId}/invariant`);
        if (r.status === 200 && r.body) {
          duringChecks.push({ sum: r.body.sum, total: r.body.total_seats, ok: r.body.holds === true });
        }
      } catch { /* the watcher must never affect the run */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  // ------------------------------------------------------------- the burst
  console.log(`\nfiring…`);
  const outcomes: Outcome[] = new Array(REQUESTS);
  const t0 = performance.now();

  const greedyRun = Promise.all(
    greedySeats.map((s, i) =>
      c.post(`/shows/${showId}/reserve`, { seats: [s], idempotency_key: `greedy-${stamp}-${i}` },
        c.auth(greedyToken)).catch((e) => ({ status: 0, body: { error: { code: String(e.message) } }, raw: '', ms: 0 })),
    ),
  );

  await pool(REQUESTS, CONCURRENCY, async (i) => {
    const job = jobs[i];
    try {
      const res = await c.post(`/shows/${showId}/reserve`,
        { seats: job.seats, idempotency_key: job.key },
        c.auth(tokens[job.userIdx]));
      outcomes[i] = {
        status: res.status,
        code: isEdgeBlocked(res) ? 'edge_blocked' : res.body?.error?.code,
        seats: res.body?.seats,
        reservationId: res.body?.reservation_id,
        userId: `storm-${stamp}-u${job.userIdx}`,
        key: job.key,
        requested: job.seats,
        replay: res.body?.replay,
        ms: res.ms,
      };
    } catch (e: any) {
      // A transport failure is counted as its own category; it is not a 4xx
      // and we must not quietly treat it as a clean decline.
      outcomes[i] = { status: -1, code: `transport:${e.message}`, userId: '', key: job.key, requested: job.seats, ms: 0 };
    }
  });

  const elapsed = (performance.now() - t0) / 1000;
  const greedyResults = await greedyRun;
  watching = false;
  await watcher;

  // ------------------------------------------------------------- reporting
  const byStatus = new Map<number, number>();
  const byCode = new Map<string, number>();
  for (const o of outcomes) {
    byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    if (o.code) byCode.set(o.code, (byCode.get(o.code) ?? 0) + 1);
  }
  const lat = outcomes.map((o) => o.ms).filter((m) => m > 0).sort((a, b) => a - b);

  console.log(`\n\x1b[1mthroughput\x1b[0m`);
  console.log(`  ${fmt(REQUESTS)} requests in ${elapsed.toFixed(2)}s = ${fmt(Math.round(REQUESTS / elapsed))} req/s`);
  console.log(`  latency  p50 ${percentile(lat, 50).toFixed(0)}ms · p95 ${percentile(lat, 95).toFixed(0)}ms ` +
              `· p99 ${percentile(lat, 99).toFixed(0)}ms · max ${percentile(lat, 100).toFixed(0)}ms`);

  console.log(`\n\x1b[1mstatus codes\x1b[0m`);
  for (const [s, n] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${s === -1 ? 'transport error' : s}  ${fmt(n)}`);
  }
  if (byCode.size) {
    console.log(`\n\x1b[1mdecline reasons\x1b[0m`);
    for (const [k, n] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ${fmt(n)}`);
  }

  // ---------------------------------------------------------- the audit
  console.log(`\n\x1b[1mcorrectness audit\x1b[0m`);

  // 1. Zero 5xx, zero transport failures.
  const fivexx = [...byStatus].filter(([s]) => s >= 500).reduce((a, [, n]) => a + n, 0);
  const transport = byStatus.get(-1) ?? 0;
  check('zero 5xx responses across the burst', fivexx === 0, `saw ${fmt(fivexx)}`);
  check('zero transport failures (no dropped connections)', transport === 0, `saw ${fmt(transport)}`);

  const shed = byCode.get('overloaded') ?? 0;
  if (shed) notes.push(`${fmt(shed)} requests were shed with 429 (admission control) — these are capacity declines, not errors`);

  // Requests a CDN or WAF answered never reached the service. They are not
  // declines and they are not errors; they are missing data, and the rest of
  // the audit compares client-side outcomes against server state, so a silent
  // hole in the former would produce false accusations about the latter.
  const edgeBlocked = byCode.get('edge_blocked') ?? 0;
  if (edgeBlocked) {
    notes.push(`${fmt(edgeBlocked)} requests were blocked at the edge before reaching the service ` +
               `(403 x-vercel-mitigated) — the host's DDoS mitigation, not a response from the app`);
  }

  // 2. Exactly one winner per hot seat.
  const finalState = await c.get(`/shows/${showId}`);
  if (isEdgeBlocked(finalState) || !finalState.body?.seats) {
    console.log(`\n\x1b[31maudit aborted\x1b[0m: could not read final show state ` +
                `(HTTP ${finalState.status}${finalState.headers['x-vercel-mitigated'] ? ', blocked at the edge' : ''}).`);
    console.log(`  The burst itself completed; the numbers above stand. What cannot be verified is the\n` +
                `  server-side reconciliation, because the host refused the read. Re-run against a local\n` +
                `  stack (docker compose up) to audit at full rate.`);
    for (const n of notes) console.log(`  note: ${n}`);
    c.destroy();
    process.exit(1);
  }
  const seatMap: Record<string, string> = finalState.body.seats;

  let hotOk = true;
  const hotDetail: string[] = [];
  for (const seat of hot) {
    const winners = outcomes.filter((o) => o.status === 201 && o.seats?.includes(seat));
    const attempts = outcomes.filter((o) => o.requested.includes(seat)).length;
    const declines = outcomes.filter((o) => o.status === 409 && o.requested.includes(seat)).length;
    const distinctWinners = new Set(winners.map((w) => w.userId));
    if (winners.length !== 1 || distinctWinners.size !== 1) hotOk = false;
    hotDetail.push(`    ${seat}: ${fmt(attempts)} attempts → ${winners.length} × 201, ` +
                   `${fmt(declines)} × 409, final=${seatMap[seat]}`);
  }
  check(`each hot seat has exactly one 201 winner`, hotOk);
  console.log(hotDetail.join('\n'));

  // 3. No seat confirmed to two users, checked from the server's own records.
  const seatOwner = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (o.status !== 201 || !o.seats) continue;
    for (const s of o.seats) {
      if (!seatOwner.has(s)) seatOwner.set(s, new Set());
      seatOwner.get(s)!.add(o.userId);
    }
  }
  const doubleSold = [...seatOwner].filter(([, owners]) => owners.size > 1);
  check('no seat was sold to two different users', doubleSold.length === 0,
    doubleSold.slice(0, 5).map(([s, o]) => `${s} -> ${[...o].join(', ')}`).join('; '));

  const dupWinners = [...seatOwner].filter(([s]) =>
    outcomes.filter((o) => o.status === 201 && o.seats?.includes(s)).length > 1);
  check('no seat produced two 201 responses', dupWinners.length === 0,
    dupWinners.slice(0, 5).map(([s]) => s).join(', '));

  // 4. Reconciliation, during and after.
  const k = finalState.body.counts;
  check('available + held + confirmed == total_seats (after)',
    k.available + k.held + k.confirmed === finalState.body.total_seats,
    `${k.available}+${k.held}+${k.confirmed} vs ${finalState.body.total_seats}`);
  const badDuring = duringChecks.filter((d) => !d.ok);
  check(`invariant held on all ${duringChecks.length} mid-burst samples`, badDuring.length === 0,
    badDuring.slice(0, 3).map((d) => `${d.sum} != ${d.total}`).join('; '));

  const inv = await c.get(`/shows/${showId}/invariant`);
  check('seat rows agree with reservation rows', inv.body?.seat_ledger_agrees === true, JSON.stringify(inv.body));

  // The greedy user's requests run alongside the burst but are tracked
  // separately, so fold them back in before comparing against server totals.
  const greedyWins = greedyResults.filter((r: any) => r.status === 201).length;
  const greedySeatsWon = greedyResults
    .filter((r: any) => r.status === 201)
    .reduce((a: number, r: any) => a + (r.body?.seats?.length ?? 0), 0);

  const confirmedSeats = Object.values(seatMap).filter((s) => s === 'confirmed').length;
  const won201 = outcomes.filter((o) => o.status === 201).reduce((a, o) => a + (o.seats?.length ?? 0), 0);
  check('every 201 corresponds to a seat that is actually confirmed',
    confirmedSeats === won201 + greedySeatsWon,
    `${confirmedSeats} confirmed seats vs ${won201}+${greedySeatsWon} seats across 201s`);

  // 5. Money: one capture per winning reservation, no double charges.
  const expectedPaise = confirmedSeats * 25_000;
  check('captured amount equals confirmed seats x price (no double charge)',
    inv.body?.captured_paise === expectedPaise,
    `captured ${fmt(inv.body?.captured_paise ?? -1)} paise, expected ${fmt(expectedPaise)}`);
  const createdReservations = outcomes.filter((o) => o.status === 201).length + greedyWins;
  check('one payment row per winning reservation',
    inv.body?.payment_rows === createdReservations,
    `${inv.body?.payment_rows} payment rows vs ${createdReservations} created reservations`);

  // 6. Idempotency: a key that was fired many times produced one reservation.
  const byKey = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (!o.reservationId) continue;
    if (!byKey.has(o.key)) byKey.set(o.key, new Set());
    byKey.get(o.key)!.add(o.reservationId);
  }
  const keyFanout = [...byKey].filter(([, ids]) => ids.size > 1);
  check('each idempotency key maps to exactly one reservation', keyFanout.length === 0,
    keyFanout.slice(0, 5).map(([key, ids]) => `${key} -> ${ids.size}`).join('; '));

  const repeatedKeys = new Map<string, number>();
  for (const o of outcomes) repeatedKeys.set(o.key, (repeatedKeys.get(o.key) ?? 0) + 1);
  const retried = [...repeatedKeys].filter(([, n]) => n > 1);
  const multi201 = retried.filter(([key]) => outcomes.filter((o) => o.key === key && o.status === 201).length > 1);
  check(`retried keys never produced a second 201 (${fmt(retried.length)} keys were retried)`,
    multi201.length === 0, multi201.slice(0, 5).map(([k]) => k).join(', '));

  // 7. Per-user limit under concurrency, for every buyer and for the greedy one.
  const seatsPerUser = new Map<string, number>();
  for (const o of outcomes) {
    if (o.status !== 201 || !o.seats) continue;
    seatsPerUser.set(o.userId, (seatsPerUser.get(o.userId) ?? 0) + o.seats.length);
  }
  const overLimit = [...seatsPerUser].filter(([, n]) => n > PER_USER_LIMIT);
  check(`no buyer exceeded the ${PER_USER_LIMIT}-seat limit`, overLimit.length === 0,
    overLimit.slice(0, 5).map(([u, n]) => `${u}=${n}`).join(', '));

  const greedy5xx = greedyResults.filter((r: any) => r.status >= 500 || r.status === 0).length;
  check(`a user firing ${greedySeats.length} parallel reserves on a limit-${PER_USER_LIMIT} show won at most ${PER_USER_LIMIT}`,
    greedyWins <= PER_USER_LIMIT && greedyWins > 0, `won ${greedyWins}`);
  check('the greedy user saw no 5xx', greedy5xx === 0, `saw ${greedy5xx}`);

  // 8. The server's own view, from /metrics.
  const metrics = await c.get('/metrics');
  check('/metrics reports zero double-sold seats', /eventbooker_double_sold_seats 0\b/.test(metrics.raw));
  check('/metrics reports reconciliation ok', /eventbooker_reconciliation_ok 1\b/.test(metrics.raw));

  console.log(`\n${'─'.repeat(70)}`);
  if (notes.length) notes.forEach((n) => console.log(`  note: ${n}`));
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} CHECK(S) FAILED\x1b[0m`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32mcorrectness audit passed — ${fmt(confirmedSeats)} seats sold, ` +
                `${fmt(expectedPaise / 100)} rupees captured, zero anomalies\x1b[0m`);
  }
  console.log(`dashboard: ${URL_BASE}/?show_id=${showId}`);
  c.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
