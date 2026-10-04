import { neon } from '@neondatabase/serverless';
import pg from 'pg';
import { config } from './config.js';

export type Row = Record<string, any>;

/**
 * Every write in this service is a single `select some_function(...)` call, and
 * each of those functions is atomic on its own. That means we never need a
 * client-side transaction, which in turn means we can run over Neon's stateless
 * HTTP driver in production -- no connection to pin, nothing to leak, and a
 * 20k-request burst does not translate into 20k Postgres connections.
 *
 * Locally we use a normal pooled `pg` client so the code path is identical
 * against a stock Postgres.
 */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  readonly driver: 'neon-http' | 'pg-pool';
  stats(): Record<string, number>;
  close(): Promise<void>;
}

// Neon's HTTP driver is the default against Neon because it needs no pooling,
// but DB_DRIVER=pg forces the ordinary pooled client against the same database
// (use Neon's -pooler host). That override exists so a driver-level problem in
// production is a config change, not a redeploy.
const forced = process.env.DB_DRIVER;
const useNeonHttp =
  forced === 'neon' || (forced !== 'pg' && /neon\.tech|neon\.build/.test(config.databaseUrl));

function makeNeon(): Db {
  const sql = neon(config.databaseUrl);
  let inFlight = 0;
  let total = 0;
  return {
    driver: 'neon-http',
    async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      inFlight++;
      total++;
      try {
        // Called as a plain function (not a tagged template) so we keep real
        // bound parameters -- no string interpolation anywhere near user input.
        return (await sql(text, params)) as T[];
      } finally {
        inFlight--;
      }
    },
    stats: () => ({ in_flight: inFlight, total_queries: total, pool_size: 0, pool_idle: 0, pool_waiting: 0 }),
    close: async () => {},
  };
}

function makePgPool(): Db {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // A request that cannot be served in this long is better off failing fast
    // than holding a connection hostage while the stampede continues.
    statement_timeout: config.statementTimeoutMs,
    ssl: /sslmode=require|neon\.tech|supabase|render\.com|amazonaws/.test(config.databaseUrl)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  pool.on('error', (err) => console.error('[pg] idle client error', err.message));

  let total = 0;
  return {
    driver: 'pg-pool',
    async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      total++;
      const res = await pool.query(text, params);
      return res.rows as T[];
    },
    stats: () => ({
      in_flight: pool.totalCount - pool.idleCount,
      total_queries: total,
      pool_size: pool.totalCount,
      pool_idle: pool.idleCount,
      pool_waiting: pool.waitingCount,
    }),
    close: () => pool.end(),
  };
}

let instance: Db | null = null;

export function db(): Db {
  if (!instance) instance = useNeonHttp ? makeNeon() : makePgPool();
  return instance;
}

/** Helper for the common `select fn(...) as result` shape. */
export async function callFn<T = any>(fnCall: string, params: unknown[]): Promise<T> {
  const rows = await db().query<{ result: T }>(`select ${fnCall} as result`, params);
  return rows[0]?.result as T;
}
