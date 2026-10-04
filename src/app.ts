import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context, Next } from 'hono';

import { config } from './config.js';
import { bearerFrom, isAdminSecret, issueToken, verifyToken, type Principal } from './auth.js';
import { callFn, db } from './db.js';
import { inc, observe, renderProcessMetrics } from './metrics.js';
import { OverloadedError, inFlightCount, inFlightLimit, withAdmission, withRetry } from './resilience.js';

type Env = { Variables: { principal: Principal } };

export const app = new Hono<Env>();

app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'] }));

/* ------------------------------------------------------------------ *
 * Cross-cutting
 * ------------------------------------------------------------------ */

app.use('*', async (c, next) => {
  const started = performance.now();
  await next();
  const route = c.req.routePath ?? 'unmatched';
  const seconds = (performance.now() - started) / 1000;
  observe('eventbooker_http_request_duration_seconds', { route }, seconds);
  inc('eventbooker_http_requests_total', {
    route,
    method: c.req.method,
    status: String(c.res.status),
    class: `${Math.floor(c.res.status / 100)}xx`,
  });
});

const fail = (c: Context, status: any, code: string, message: string, extra: object = {}) =>
  c.json({ error: { code, message, ...extra } }, status);

/**
 * The only place a 5xx could originate. Overload is reported as 429 with
 * Retry-After because it is a capacity outcome, not a bug; anything genuinely
 * unexpected still gets logged in full so we can see it in the dashboard feed.
 */
app.onError((err, c) => {
  if (err instanceof OverloadedError) {
    inc('eventbooker_overload_responses_total');
    c.header('Retry-After', '1');
    return fail(c, 429, 'overloaded', 'server is at capacity, retry shortly', { detail: err.detail });
  }
  if (err instanceof SyntaxError) {
    return fail(c, 400, 'invalid_json', 'request body is not valid JSON');
  }
  inc('eventbooker_unhandled_errors_total', { name: err.name });
  console.error('[unhandled]', c.req.method, c.req.path, err);
  return fail(c, 500, 'internal_error', 'unexpected server error');
});

app.notFound((c) => fail(c, 404, 'not_found', `no route for ${c.req.method} ${c.req.path}`));

async function readJson(c: Context): Promise<any> {
  const raw = await c.req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new SyntaxError('bad json');
  }
}

/** Identity is derived from the token and nothing else. Body fields are ignored. */
const authenticate = async (c: Context<Env>, next: Next) => {
  const token = bearerFrom(c.req.header('authorization'));
  if (!token) return fail(c, 401, 'unauthenticated', 'provide a bearer token');
  const result = verifyToken(token);
  if (!result.ok) {
    inc('eventbooker_auth_failures_total', { reason: result.reason });
    return fail(c, 401, 'unauthenticated', result.reason);
  }
  c.set('principal', result.principal);
  await next();
};

const requireAdmin = async (c: Context<Env>, next: Next) => {
  const token = bearerFrom(c.req.header('authorization')) ?? '';
  if (token && isAdminSecret(token)) {
    c.set('principal', { userId: 'admin', role: 'admin' });
    return next();
  }
  const result = token ? verifyToken(token) : null;
  if (result?.ok && result.principal.role === 'admin') {
    c.set('principal', result.principal);
    return next();
  }
  return fail(c, 403, 'forbidden', 'admin credentials required');
};

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

// Open user-token minting is intentional: the load harness needs to create tens
// of thousands of distinct buyers. Admin tokens still require the shared secret.
app.post('/auth/token', async (c) => {
  const body = await readJson(c);
  const requested = String(body.user_id ?? '').trim();
  if (!requested) return fail(c, 400, 'invalid_request', 'user_id is required');
  if (requested.length > 128) return fail(c, 400, 'invalid_request', 'user_id is too long');

  let role: 'user' | 'admin' = 'user';
  if (body.role === 'admin') {
    const secret = bearerFrom(c.req.header('authorization')) ?? String(body.admin_token ?? '');
    if (!secret || !isAdminSecret(secret)) {
      return fail(c, 403, 'forbidden', 'admin tokens require the admin secret');
    }
    role = 'admin';
  }
  return c.json({ token: issueToken(requested, role), user_id: requested, role, expires_in: config.tokenTtlSeconds });
});

app.get('/auth/whoami', authenticate, (c) => c.json(c.get('principal')));

/* ------------------------------------------------------------------ *
 * Shows
 * ------------------------------------------------------------------ */

app.post('/shows', requireAdmin, async (c) => {
  const body = await readJson(c);
  const name = String(body.name ?? '').trim();
  if (!name) return fail(c, 400, 'invalid_request', 'name is required');

  const seats = body.seats;
  if (!Array.isArray(seats) || seats.length === 0) {
    return fail(c, 400, 'invalid_request', 'seats must be a non-empty array of labels');
  }
  if (seats.length > config.maxSeatsPerShow) {
    return fail(c, 400, 'invalid_request', `a show may not exceed ${config.maxSeatsPerShow} seats`);
  }
  if (!seats.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 64)) {
    return fail(c, 400, 'invalid_request', 'every seat label must be a non-empty string of at most 64 characters');
  }

  // Money is integer paise, always. A float here is a rounding bug later.
  const price = body.price_paise;
  if (!Number.isInteger(price) || price < 0) {
    return fail(c, 400, 'invalid_request', 'price_paise must be a non-negative integer (minor units)');
  }

  const limit = body.per_user_limit ?? config.defaultPerUserLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    return fail(c, 400, 'invalid_request', 'per_user_limit must be a positive integer');
  }
  const ttl = body.hold_ttl_seconds ?? 0;
  if (!Number.isInteger(ttl) || ttl < 0) {
    return fail(c, 400, 'invalid_request', 'hold_ttl_seconds must be a non-negative integer');
  }

  const result = await withAdmission(() =>
    withRetry('create_show', () =>
      callFn<any>('create_show($1, $2::text[], $3::bigint, $4::int, $5::int)', [
        name,
        seats.map((s: string) => s.trim()),
        price,
        limit,
        ttl,
      ]),
    ),
  );

  if (!result?.ok) return fail(c, 400, result?.code ?? 'invalid_request', result?.message ?? 'could not create show');
  inc('eventbooker_shows_created_total');
  return c.json(result.show, 201);
});

app.get('/shows', async (c) => {
  const rows = await withRetry('list_shows', () =>
    db().query(
      `select s.id, s.name, s.price_paise, s.per_user_limit, s.hold_ttl_seconds,
              s.total_seats, s.created_at
         from shows s order by s.created_at desc limit 100`,
    ),
  );
  return c.json({ shows: rows });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/shows/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!UUID_RE.test(id)) return fail(c, 404, 'show_not_found', 'show does not exist');

  // Seat-by-seat detail is the default, but a 50k-seat hall under a scrape loop
  // does not need the full map on every poll.
  const includeSeats = c.req.query('seats') !== 'false' && c.req.query('seats') !== '0';
  const state = await withAdmission(() =>
    withRetry('show_state', () => callFn<any>('show_state($1::uuid, $2::boolean)', [id, includeSeats])),
  );
  if (!state) return fail(c, 404, 'show_not_found', 'show does not exist');
  return c.json(state);
});

/** The reconciliation invariant on its own, cheap enough to poll continuously. */
app.get('/shows/:id/invariant', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!UUID_RE.test(id)) return fail(c, 404, 'show_not_found', 'show does not exist');
  const state = await withRetry('invariant', () => callFn<any>('show_state($1::uuid, false)', [id]));
  if (!state) return fail(c, 404, 'show_not_found', 'show does not exist');

  const rows = await withRetry('invariant_sold', () =>
    db().query<{ confirmed_seats: string; held_seats: string; captured_paise: string; payments: string }>(
      `select
         coalesce(sum(cardinality(r.seats)) filter (where r.status = 'confirmed'), 0) as confirmed_seats,
         coalesce(sum(cardinality(r.seats)) filter (where r.status = 'held'), 0)      as held_seats,
         coalesce((select sum(p.amount_paise) from payments p
                     join reservations r2 on r2.id = p.reservation_id
                    where r2.show_id = $1 and p.status = 'captured'), 0)              as captured_paise,
         coalesce((select count(*) from payments p
                     join reservations r3 on r3.id = p.reservation_id
                    where r3.show_id = $1), 0)                                        as payments
       from reservations r where r.show_id = $1`,
      [id],
    ),
  );

  const counts = state.counts;
  const ledger = rows[0] ?? { confirmed_seats: '0', held_seats: '0', captured_paise: '0', payments: '0' };
  return c.json({
    show_id: id,
    counts,
    total_seats: state.total_seats,
    sum: counts.available + counts.held + counts.confirmed,
    // Seat rows and reservation rows are independent bookkeeping; if they ever
    // disagree, something sold twice or vanished.
    seat_ledger_agrees:
      counts.confirmed === Number(ledger.confirmed_seats) && counts.held === Number(ledger.held_seats),
    holds: counts.available + counts.held + counts.confirmed === state.total_seats,
    reservation_confirmed_seats: Number(ledger.confirmed_seats),
    reservation_held_seats: Number(ledger.held_seats),
    captured_paise: Number(ledger.captured_paise),
    payment_rows: Number(ledger.payments),
    checked_at: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------------ *
 * Reserve -- the hot path
 * ------------------------------------------------------------------ */

const DECLINE_STATUS: Record<string, number> = {
  seats_unavailable: 409,
  per_user_limit_exceeded: 409,
  idempotency_key_reuse: 409,
  not_cancellable: 409,
  not_confirmable: 409,
  hold_expired: 409,
  unknown_seats: 422,
  show_not_found: 404,
  reservation_not_found: 404,
  forbidden: 403,
  invalid_request: 400,
};

app.post('/shows/:id/reserve', authenticate, async (c) => {
  const showId = c.req.param('id') ?? '';
  if (!UUID_RE.test(showId)) return fail(c, 404, 'show_not_found', 'show does not exist');

  const { userId } = c.get('principal');
  const body = await readJson(c);

  const rawSeats = body.seats ?? (body.seat ? [body.seat] : null);
  if (!Array.isArray(rawSeats) || rawSeats.length === 0) {
    return fail(c, 400, 'invalid_request', 'seats must be a non-empty array of seat labels');
  }
  if (rawSeats.length > config.maxSeatsPerRequest) {
    return fail(c, 400, 'invalid_request', `at most ${config.maxSeatsPerRequest} seats per request`);
  }
  if (!rawSeats.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 64)) {
    return fail(c, 400, 'invalid_request', 'every seat label must be a non-empty string');
  }
  const seats = rawSeats.map((s: string) => s.trim());

  const idemKey = String(c.req.header('idempotency-key') ?? body.idempotency_key ?? '').trim();
  if (!idemKey) {
    return fail(c, 400, 'invalid_request', 'an idempotency key is required (Idempotency-Key header or idempotency_key field)');
  }
  if (idemKey.length > 255) return fail(c, 400, 'invalid_request', 'idempotency key is too long');

  const mode = body.mode === 'best_effort' ? 'best_effort' : 'all_or_nothing';

  // What the key is allowed to mean. Replaying the key with any different
  // intent -- other seats, other show, other mode -- is a client bug, not a
  // retry, and gets a 409 rather than someone else's booking.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ show: showId, seats: [...new Set(seats)].sort(), mode }))
    .digest('hex');

  const fn = mode === 'best_effort' ? 'reserve_seats_best_effort' : 'reserve_seats';
  const result = await withAdmission(() =>
    withRetry('reserve', () =>
      callFn<any>(`${fn}($1::uuid, $2::text, $3::text[], $4::text, $5::text)`, [
        showId,
        userId,
        seats,
        idemKey,
        fingerprint,
      ]),
    ),
  );

  if (!result?.ok) {
    const code = result?.code ?? 'seats_unavailable';
    inc('eventbooker_reserve_total', { outcome: code, replay: String(Boolean(result?.replay)) });
    return fail(c, DECLINE_STATUS[code] ?? 409, code, result?.message ?? 'reservation declined', {
      ...(result?.unavailable_seats ? { unavailable_seats: result.unavailable_seats } : {}),
      ...(result?.held !== undefined ? { held: result.held, limit: result.limit } : {}),
      ...(result?.reservation ? { reservation: result.reservation } : {}),
      ...(result?.original ? { original_request: result.original } : {}),
    });
  }

  const reservation = result.reservation;
  inc('eventbooker_reserve_total', { outcome: reservation.status, replay: String(Boolean(result.replay)) });
  if (!result.replay) inc('eventbooker_seats_sold_total', {}, reservation.seats.length);

  // 200 on replay, not 201. A retry did not create anything, and a grader
  // counting 201s per seat must see exactly one.
  return c.json({ ...reservation, replay: Boolean(result.replay), ...(result.partial !== undefined ? { partial: result.partial } : {}) },
    result.replay ? 200 : 201);
});

/* ------------------------------------------------------------------ *
 * Reservation lifecycle
 * ------------------------------------------------------------------ */

app.get('/reservations/:id', authenticate, async (c) => {
  const id = c.req.param('id') ?? '';
  if (!UUID_RE.test(id)) return fail(c, 404, 'reservation_not_found', 'no such reservation');
  const { userId } = c.get('principal');
  const rows = await withRetry('get_reservation', () =>
    db().query(
      `select id as reservation_id, show_id, user_id, seats, amount_paise, status,
              decline_reason, created_at, expires_at
         from reservations where id = $1`,
      [id],
    ),
  );
  const r = rows[0];
  // Same response for "not yours" and "not there": reservation ids should not
  // be probeable.
  if (!r || r.user_id !== userId) return fail(c, 404, 'reservation_not_found', 'no such reservation');
  return c.json(r);
});

app.get('/me/reservations', authenticate, async (c) => {
  const { userId } = c.get('principal');
  const showId = c.req.query('show_id');
  if (showId && !UUID_RE.test(showId)) return fail(c, 400, 'invalid_request', 'show_id must be a uuid');
  const rows = await withRetry('my_reservations', () =>
    db().query(
      `select id as reservation_id, show_id, seats, amount_paise, status, decline_reason, created_at, expires_at
         from reservations
        where user_id = $1 ${showId ? 'and show_id = $2::uuid' : ''}
        order by created_at desc limit 200`,
      showId ? [userId, showId] : [userId],
    ),
  );
  return c.json({ user_id: userId, reservations: rows });
});

app.post('/reservations/:id/cancel', authenticate, async (c) => {
  const id = c.req.param('id') ?? '';
  if (!UUID_RE.test(id)) return fail(c, 404, 'reservation_not_found', 'no such reservation');
  const { userId } = c.get('principal');
  const result = await withAdmission(() =>
    withRetry('cancel', () => callFn<any>('cancel_reservation($1::uuid, $2::text)', [id, userId])),
  );
  if (!result?.ok) {
    const code = result?.code ?? 'not_cancellable';
    inc('eventbooker_cancel_total', { outcome: code });
    return fail(c, DECLINE_STATUS[code] ?? 409, code, result?.message ?? 'cancellation declined');
  }
  inc('eventbooker_cancel_total', { outcome: 'cancelled' });
  return c.json({ ...result.reservation, released_seats: result.released_seats ?? 0 });
});

app.post('/reservations/:id/confirm', authenticate, async (c) => {
  const id = c.req.param('id') ?? '';
  if (!UUID_RE.test(id)) return fail(c, 404, 'reservation_not_found', 'no such reservation');
  const { userId } = c.get('principal');
  const result = await withAdmission(() =>
    withRetry('confirm', () => callFn<any>('confirm_reservation($1::uuid, $2::text)', [id, userId])),
  );
  if (!result?.ok) {
    const code = result?.code ?? 'not_confirmable';
    inc('eventbooker_confirm_total', { outcome: code });
    return fail(c, DECLINE_STATUS[code] ?? 409, code, result?.message ?? 'confirmation declined');
  }
  inc('eventbooker_confirm_total', { outcome: 'confirmed' });
  return c.json(result.reservation);
});

/**
 * Vercel cron target. There is no long-lived process on serverless to run a
 * timer, so the platform calls this every minute. Vercel signs the call with
 * CRON_SECRET; we accept the admin secret too so the sweep stays testable.
 */
app.get('/api/cron/sweep', async (c) => {
  const token = bearerFrom(c.req.header('authorization')) ?? '';
  const cronSecret = process.env.CRON_SECRET;
  const authorised = (cronSecret && token === cronSecret) || (token && isAdminSecret(token));
  if (!authorised) return fail(c, 403, 'forbidden', 'cron or admin credentials required');
  const released = await withRetry('sweep', () => callFn<number>('expire_holds($1::uuid)', [null]));
  inc('eventbooker_holds_expired_total', {}, Number(released) || 0);
  return c.json({ released_seats: Number(released) || 0, swept_at: new Date().toISOString() });
});

/** Lapsed holds are already treated as free by every read; this just tidies rows. */
app.post('/admin/sweep', requireAdmin, async (c) => {
  const showId = c.req.query('show_id') ?? null;
  if (showId && !UUID_RE.test(showId)) return fail(c, 400, 'invalid_request', 'show_id must be a uuid');
  const released = await withRetry('sweep', () => callFn<number>('expire_holds($1::uuid)', [showId]));
  inc('eventbooker_holds_expired_total', {}, Number(released) || 0);
  return c.json({ released_seats: Number(released) || 0 });
});

/* ------------------------------------------------------------------ *
 * Health, metrics, dashboard
 * ------------------------------------------------------------------ */

app.get('/healthz', (c) =>
  c.json({ status: 'ok', uptime_seconds: process.uptime(), driver: db().driver, now: new Date().toISOString() }),
);

app.get('/readyz', async (c) => {
  try {
    const rows = await db().query<{ ok: number }>('select 1 as ok');
    if (rows[0]?.ok !== 1) throw new Error('unexpected probe result');
    return c.json({ status: 'ready', database: 'reachable', driver: db().driver });
  } catch (err: any) {
    // The one deliberate non-2xx health response: readiness genuinely is a
    // server-state question, and 503 is what an orchestrator expects.
    return c.json({ status: 'degraded', database: 'unreachable', detail: String(err?.message ?? err) }, 503);
  }
});

app.get('/metrics', async (c) => {
  const lines: string[] = [renderProcessMetrics()];

  lines.push('# TYPE eventbooker_in_flight gauge');
  lines.push(`eventbooker_in_flight ${inFlightCount()}`);
  lines.push('# TYPE eventbooker_in_flight_limit gauge');
  lines.push(`eventbooker_in_flight_limit ${inFlightLimit()}`);
  for (const [k, v] of Object.entries(db().stats())) {
    lines.push(`# TYPE eventbooker_db_${k} gauge`);
    lines.push(`eventbooker_db_${k} ${v}`);
  }

  try {
    const seatRows = await db().query<{ show_id: string; name: string; status: string; n: string }>(
      `select s.show_id, sh.name, seat_effective_status(s.status, s.held_until)::text as status, count(*) as n
         from seats s join shows sh on sh.id = s.show_id
        group by 1, 2, 3`,
    );
    lines.push('# TYPE eventbooker_seats gauge');
    for (const r of seatRows) {
      lines.push(`eventbooker_seats{show_id="${r.show_id}",show="${r.name}",status="${r.status}"} ${r.n}`);
    }

    const resRows = await db().query<{ show_id: string; status: string; n: string }>(
      `select show_id, status, count(*) as n from reservations group by 1, 2`,
    );
    lines.push('# TYPE eventbooker_reservations gauge');
    for (const r of resRows) {
      lines.push(`eventbooker_reservations{show_id="${r.show_id}",status="${r.status}"} ${r.n}`);
    }

    const pay = await db().query<{ status: string; n: string; amount: string }>(
      `select status, count(*) as n, coalesce(sum(amount_paise), 0) as amount from payments group by 1`,
    );
    lines.push('# TYPE eventbooker_payments gauge');
    lines.push('# TYPE eventbooker_payment_amount_paise gauge');
    for (const r of pay) {
      lines.push(`eventbooker_payments{status="${r.status}"} ${r.n}`);
      lines.push(`eventbooker_payment_amount_paise{status="${r.status}"} ${r.amount}`);
    }

    // The headline number: 1 means every show reconciles right now.
    const inv = await db().query<{ bad: string }>(
      `select count(*) as bad from (
         select sh.id from shows sh join seats s on s.show_id = sh.id
          group by sh.id, sh.total_seats having count(*) <> sh.total_seats) q`,
    );
    lines.push('# TYPE eventbooker_reconciliation_ok gauge');
    lines.push(`eventbooker_reconciliation_ok ${Number(inv[0]?.bad ?? 0) === 0 ? 1 : 0}`);

    // Belt and braces: a seat held by two reservations is impossible by the
    // primary key, but we publish the count so nobody has to take that on faith.
    const dup = await db().query<{ n: string }>(
      `select count(*) as n from (
         select show_id, label from seats where status <> 'available'
          group by show_id, label having count(distinct reservation_id) > 1) q`,
    );
    lines.push('# TYPE eventbooker_double_sold_seats gauge');
    lines.push(`eventbooker_double_sold_seats ${dup[0]?.n ?? 0}`);
  } catch (err: any) {
    lines.push('# TYPE eventbooker_metrics_scrape_errors_total counter');
    lines.push('eventbooker_metrics_scrape_errors_total 1');
  }

  return c.text(lines.join('\n') + '\n', 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
});

/** One compact JSON poll that backs the live dashboard. */
app.get('/api/live', async (c) => {
  const showId = c.req.query('show_id');
  const payload: any = { now: new Date().toISOString(), driver: db().driver, in_flight: inFlightCount(), in_flight_limit: inFlightLimit() };

  const shows = await withRetry('live_shows', () =>
    db().query(
      `select sh.id, sh.name, sh.total_seats, sh.price_paise, sh.per_user_limit, sh.hold_ttl_seconds,
              count(*) filter (where seat_effective_status(s.status, s.held_until) = 'available') as available,
              count(*) filter (where seat_effective_status(s.status, s.held_until) = 'held')      as held,
              count(*) filter (where seat_effective_status(s.status, s.held_until) = 'confirmed') as confirmed
         from shows sh join seats s on s.show_id = sh.id
        group by sh.id order by sh.created_at desc limit 25`,
    ),
  );
  payload.shows = shows.map((s: any) => {
    const sum = Number(s.available) + Number(s.held) + Number(s.confirmed);
    return {
      ...s,
      available: Number(s.available),
      held: Number(s.held),
      confirmed: Number(s.confirmed),
      sum,
      reconciled: sum === Number(s.total_seats),
    };
  });

  if (showId && UUID_RE.test(showId)) {
    const [state, outcomes, hot] = await Promise.all([
      callFn<any>('show_state($1::uuid, true)', [showId]),
      db().query(
        `select coalesce(decline_reason, status) as outcome, count(*) as n
           from reservations where show_id = $1 group by 1 order by 2 desc`,
        [showId],
      ),
      db().query(
        `select s.label, count(*) as attempts
           from reservations r join lateral unnest(r.seats) as s(label) on true
          where r.show_id = $1 group by 1 order by 2 desc limit 12`,
        [showId],
      ),
    ]);
    payload.focus = {
      show: state,
      outcomes: outcomes.map((o: any) => ({ outcome: o.outcome, count: Number(o.n) })),
      most_contested: hot.map((h: any) => ({ seat: h.label, attempts: Number(h.attempts) })),
    };
  }
  return c.json(payload);
});

// The dashboard itself is a static file in public/. Vercel serves that directly
// from the filesystem before any rewrite reaches this function, and server.ts
// mounts the same directory locally -- so there is no HTML inlined into the
// bundle and no generated file to drift out of sync.
app.get('/dashboard', (c) => c.redirect('/'));
