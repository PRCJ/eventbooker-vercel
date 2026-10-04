/**
 * Seeds a hall that shows all three seat states at once, so the dashboard has
 * something real to display.
 *
 *   npx tsx scripts/demo.ts [--url http://localhost:3000] [--admin <secret>]
 *
 * Uses hold mode (hold_ttl_seconds > 0) so some seats sit in "held" while
 * others are confirmed and the rest stay available.
 */
import { Client, pool } from '../loadtest/client.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const URL_BASE = args.get('url') ?? process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = args.get('admin') ?? process.env.ADMIN_TOKEN ?? 'dev-only-admin-token';
const c = new Client(URL_BASE, 64);

const ROWS = 10;
const PER_ROW = 14;
const seats = Array.from({ length: ROWS * PER_ROW }, (_, i) => `R${Math.floor(i / PER_ROW) + 1}S${(i % PER_ROW) + 1}`);

const uniq = () => Math.random().toString(36).slice(2, 10);

const show = await c.post('/shows', {
  name: 'friday-night',
  seats,
  price_paise: 25_000,
  per_user_limit: 4,
  hold_ttl_seconds: 900,
}, c.auth(ADMIN));

if (show.status !== 201) throw new Error(`create failed: ${show.status} ${show.raw.slice(0, 200)}`);
const showId = show.body.id as string;

// Centre seats go first, the way a real hall fills.
const desirability = (label: string) => {
  const [, r, s] = /^R(\d+)S(\d+)$/.exec(label)!.map(Number) as unknown as [string, number, number];
  return Math.abs(s - PER_ROW / 2) + r * 0.8;
};
const ordered = [...seats].sort((a, b) => desirability(a) - desirability(b));
const wanted = ordered.slice(0, 62);

const results = await pool(wanted.length, 24, async (i) => {
  const tok = await c.token(`demo-${uniq()}`);
  const r = await c.post(`/shows/${showId}/reserve`,
    { seats: [wanted[i]], idempotency_key: uniq() }, c.auth(tok));
  return { r, tok };
});

// Confirm about two thirds of the holds, leave the rest sitting as holds.
const held = results.filter((x) => x.r.status === 201);
await pool(Math.floor(held.length * 0.65), 16, (i) =>
  c.post(`/reservations/${held[i].r.body.reservation_id}/confirm`, {}, c.auth(held[i].tok)));

const state = await c.get(`/shows/${showId}?seats=false`);
console.log(`show_id: ${showId}`);
console.log(`counts : ${JSON.stringify(state.body.counts)}  total=${state.body.total_seats}`);
console.log(`dashboard: ${URL_BASE}/?show_id=${showId}`);
c.destroy();
