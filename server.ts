/** Local / container entrypoint. On Vercel, api/index.ts is used instead. */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app } from './src/app.js';
import { assertProductionSafety, config } from './src/config.js';
import { db } from './src/db.js';
import { callFn } from './src/db.js';

assertProductionSafety();

// Stand in for Vercel's static hosting of public/. Registered last so it only
// catches paths no API route claimed.
app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`EventBooker listening on http://localhost:${info.port}  (driver: ${db().driver})`);
});

// Lapsed holds are already invisible to readers via seat_is_free(), so this
// sweep is housekeeping. On Vercel the same work is driven by a cron hitting
// POST /admin/sweep, since there is no long-lived process to run a timer.
const sweepMs = Number(process.env.SWEEP_INTERVAL_MS ?? 5000);
const sweeper = setInterval(() => {
  callFn<number>('expire_holds($1::uuid)', [null]).catch((e) =>
    console.error('[sweep] failed:', e?.message ?? e),
  );
}, sweepMs);

async function shutdown(signal: string) {
  console.log(`\n${signal} received, draining…`);
  clearInterval(sweeper);
  server.close();
  await db().close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
