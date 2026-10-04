/**
 * Applies db/*.sql in order. Every file is written to be idempotent (create if
 * not exists / create or replace), so re-running is a no-op and deploys do not
 * need a separate migration state table.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'db');

const files = readdirSync(dir)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

const client = new pg.Client({
  connectionString: config.databaseUrl,
  ssl: /sslmode=require|neon\.tech|supabase|render\.com|amazonaws/.test(config.databaseUrl)
    ? { rejectUnauthorized: false }
    : undefined,
});

await client.connect();
try {
  for (const f of files) {
    process.stdout.write(`applying ${f} ... `);
    await client.query(readFileSync(resolve(dir, f), 'utf8'));
    console.log('ok');
  }
  const { rows } = await client.query(
    `select count(*)::int as n from pg_proc where proname in
       ('reserve_seats','reserve_seats_best_effort','cancel_reservation',
        'confirm_reservation','expire_holds','show_state','create_show')`,
  );
  console.log(`\nmigration complete — ${rows[0].n}/7 functions installed`);
} finally {
  await client.end();
}
