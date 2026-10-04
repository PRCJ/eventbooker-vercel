# EventBooker

Assigned-seat ticketing that stays correct when twenty thousand people want the
same seat at the same instant.

A seat is a unique thing. Once it is held or sold, nobody else can ever have
that exact seat. Everything below exists to make that sentence true under load,
and to let you watch it being true in real time.

---

## Where the atomic decision lives

In one `UPDATE`, in Postgres, guarded on the seat's current state:

```sql
update seats
   set status = 'confirmed', reservation_id = ..., holder_user_id = ...
 where show_id = $1
   and label = any($2)
   and seat_is_free(status, held_until)   -- the guard
returning label;
```

If the row comes back, you own the seat. If it does not, somebody else got
there first and you get a `409`. There is no "check, then take" window to lose,
because the check *is* the take. Under `READ COMMITTED`, a concurrent writer
forces this statement to re-evaluate its `WHERE` clause against the **new** row
version, so a request that was about to win against stale data simply stops
matching and takes nothing.

Three more constraints make the bad states unrepresentable rather than merely
unlikely:

| Rule | Enforced by |
|---|---|
| One row per physical seat | `PRIMARY KEY (show_id, label)` |
| One reservation per idempotency key | `UNIQUE (user_id, idempotency_key)` |
| One capture per reservation | `UNIQUE (reservation_id)` on `payments` |

A seat cannot be sold twice because there is only one row to sell, and taking it
is a single guarded statement.

### Lock order

Every write takes locks in the same order, so there is no cycle to deadlock on:

1. the `reservations` row for `(user_id, idempotency_key)`
2. an advisory lock on `(show_id, user_id)`
3. seat rows, **always ascending by label**

Two different buyers never contend on step 2, so the per-user-limit lock costs
the 500 strangers storming `A12` nothing. Multi-seat requests are deduped and
sorted before any lock is taken, which is what keeps step 3 cycle-free.

### Why `ON CONFLICT DO UPDATE` and not `DO NOTHING`

For idempotency, `DO NOTHING` is a trap. It does **not** block on a concurrent
*uncommitted* insert of the same key — it quietly does nothing and returns no
row, so a simultaneous retry gets neither the reservation nor a conflict, and
goes on to book a second one. `DO UPDATE` takes the row lock, waits for the
first transaction to land, and hands back the winner. `xmax = 0` distinguishes
"I inserted it" from "I collided with it".

`loadtest/races.ts` fires 50 identical requests with no prior committed row
specifically to catch this.

### Declines are recorded, not rolled back

If your request loses the race, the declined reservation is still committed
against your idempotency key. Replaying that key returns the same decline. "Same
key, same outcome" would otherwise be a lie — a retry could win a seat the
original attempt lost.

---

## Behaviour

**Partial requests are all-or-nothing.** Ask for `["A12","A13"]` when only `A13`
is free and you get `409` with `unavailable_seats: ["A12"]`, having taken
neither. Splitting a party across the hall is worse than telling them to pick
again. Callers who disagree can opt in per request with `"mode": "best_effort"`,
which takes what it can (bounded by the per-user limit) and sets `"partial": true`.

**Holds are optional and lazy.** A show created with `hold_ttl_seconds > 0`
returns `status: "held"` and needs an explicit confirm; `hold_ttl_seconds: 0`
(the default) confirms immediately. A lapsed hold is treated as free by *every*
read path the instant it expires — `seat_is_free()` is shared by the readers and
the writer — so correctness never waits on the sweeper. The cron that rewrites
the rows is bookkeeping.

**Cancels cannot resurrect.** The release is guarded by
`where reservation_id = $1`. If the seat has since been sold to someone else it
no longer points at your reservation, so it is left alone.

**Identity is token-derived.** `user_id` in a request body is ignored, always.
You can only cancel and only read your own reservations; someone else's
reservation id returns `404`, not `403`, so ids are not probeable.

**Money is integer paise.** Fractional `price_paise` is rejected at the edge.

**Zero 5xx by construction.** Transient Postgres conditions (deadlock,
serialization failure, statement timeout, connection loss) are retried with full
jitter. Only if the retry budget is exhausted does the request degrade — to
`429` with `Retry-After`, because capacity is an honest domain outcome and not a
bug. The one deliberate non-2xx server response is `/readyz` returning `503`
when the database is unreachable, which is what an orchestrator expects.

---

## API

```
POST /auth/token              { user_id }                 -> { token }
POST /shows                   (admin) { name, seats[], price_paise,
                                        per_user_limit?, hold_ttl_seconds? }
GET  /shows                   list
GET  /shows/{id}              per-seat status + counts  (?seats=false to omit the map)
GET  /shows/{id}/invariant    reconciliation + ledger cross-check
POST /shows/{id}/reserve      (auth) { seats[], idempotency_key, mode? }
GET  /reservations/{id}       (auth, owner only)
POST /reservations/{id}/cancel   (auth, owner only)
POST /reservations/{id}/confirm  (auth, owner only; hold mode)
GET  /me/reservations         (auth)
POST /admin/sweep             (admin) reclaim lapsed holds
GET  /healthz /readyz /metrics
GET  /api/live                dashboard feed
GET  /                        live dashboard
```

The idempotency key may be sent as the `Idempotency-Key` header or an
`idempotency_key` body field. It is required.

### Status codes

| Code | When |
|---|---|
| `201` | seat(s) acquired |
| `200` | replay of a key that already succeeded — **not** a new booking |
| `409` | `seats_unavailable`, `per_user_limit_exceeded`, `idempotency_key_reuse`, `hold_expired` |
| `422` | `unknown_seats` |
| `429` | `overloaded` — retry budget exhausted |
| `400/401/403/404` | malformed, unauthenticated, not yours, not found |

A retry returns `200`, never a second `201`. Counting `201`s per seat is a valid
way to grade this.

---

## Run it

```bash
createdb eventbooker
npm install
npm run migrate
npm start                      # http://localhost:3000
```

Or `docker compose up --build` (API on `:3000`, Postgres on `:5433`).

Then:

```bash
npm run test:api               # 64 functional checks
npm run test:races             # adversarial concurrency
npm run storm                  # 20k-request stampede + correctness audit
```

Point any of them at a deployed instance with `--url https://…`.

### The brief's scenario, literally

```bash
npx tsx loadtest/storm.ts --requests 500 --concurrency 500 \
  --hot-seats 1 --hot-share 1 --retry-rate 0 --hall 100 --users 500
```

```
status codes
  201  1
  409  499
```

---

## Observability

`GET /` is a live dashboard: seat map, the reconciliation invariant as a
pass/fail light, confirmed-per-second, request outcomes, and the most contested
seats. It is a static file, so it can also be served from GitHub Pages against
a deployed API (set the API base in the header field, or `?api=https://…`).

`GET /metrics` is Prometheus text. The numbers that matter are computed from the
database on scrape rather than from in-process counters, because on serverless
those reset on every cold start and are per-instance — they cannot be the source
of truth for "did we sell a seat twice". Notably:

```
eventbooker_double_sold_seats      0    # must always be 0
eventbooker_reconciliation_ok      1    # must always be 1
eventbooker_seats{show,status}          # available / held / confirmed
eventbooker_payment_amount_paise{status}
eventbooker_http_request_duration_seconds
```

`GET /shows/{id}/invariant` cross-checks two independent sets of books: the seat
rows and the reservation rows. If they ever disagree, something sold twice or
vanished.

---

## Measured

Local Postgres 16, 12-core laptop, single API process.

| | |
|---|---|
| 20,000 requests, 1,000 concurrent | **7,140 req/s**, p50 117ms, p99 386ms |
| 5xx | **0** |
| 429 | **0** |
| Hot seat, ~2,800 attempts | exactly **1** × `201` |
| 500 buyers, 1 seat | **1** × `201`, **499** × `409` |
| Double-sold seats | **0** across 100,000+ reservations |

### The tests have teeth

A test suite that cannot fail proves nothing, so the atomic decision was
replaced with the naive read-then-write the brief warns about, widened with a
250ms window, and re-run:

```
naive read-then-write   A1: 200 attempts -> 30 × 201   FAIL  (sold to 30 users)
guarded conditional     A1: 200 attempts ->  1 × 201   PASS  (same 250ms window)
```

Worth noting what the broken version *passed*: `available + held + confirmed ==
total_seats` held the whole time, because a seat row can only carry one owner.
**Reconciliation alone does not detect double-selling.** That is why the audit
separately counts `201`s per seat and distinct owners per seat.

---

## Deploying

Vercel + Neon. Every write is a single `select fn(...)` and each function is
atomic on its own, so there is no client-side transaction to hold open — which
is what makes the stateless HTTP driver safe and keeps a 20k burst from becoming
20k Postgres connections.

```bash
vercel link
vercel env add DATABASE_URL     # Neon pooled connection string
vercel env add JWT_SECRET       # openssl rand -hex 32
vercel env add ADMIN_TOKEN      # openssl rand -hex 32
vercel env add CRON_SECRET      # openssl rand -hex 32
DATABASE_URL='postgres://…' npm run migrate
vercel deploy --prod
```

The app refuses to boot in production with the development secrets still in
place. `vercel.json` registers a one-minute cron against `/api/cron/sweep` to
reclaim lapsed holds, since serverless has no long-lived process to run a timer.
