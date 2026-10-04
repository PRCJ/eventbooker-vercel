import { config } from './config.js';
import { inc } from './metrics.js';

/**
 * Transient Postgres conditions. None of these mean "the request was wrong" --
 * they mean "try again in a moment". Surfacing them as 500s would be a lie, and
 * the brief says zero 5xx, so we retry them and, only if they keep happening,
 * degrade to an honest 429.
 */
const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
  '53300', // too_many_connections
  '08006', // connection_failure
  '08003', // connection_does_not_exist
  '08000', // connection_exception
]);

export class OverloadedError extends Error {
  constructor(public readonly detail: string) {
    super('service is shedding load');
  }
}

function isRetryable(err: any): boolean {
  if (!err) return false;
  if (err.code && RETRYABLE.has(String(err.code))) return true;
  const msg = String(err.message ?? '');
  return /ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|socket hang up|fetch failed/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      inc('eventbooker_db_retries_total', { op: label, code: String((err as any).code ?? 'io') });
      // Full jitter. A deadlock storm retried in lockstep just deadlocks again.
      await sleep(Math.random() * Math.min(120 * 2 ** i, 800));
    }
  }
  inc('eventbooker_db_retries_exhausted_total', { op: label });
  throw new OverloadedError(String(lastErr?.message ?? lastErr));
}

/**
 * Admission control -- a last-resort safety valve, not a throttle.
 *
 * The connection pool already queues, and a queued request still gets its seat.
 * So this limit is set well above any realistic burst (a 20k-request stampede
 * peaks around 1k in flight) and exists only to stop an unbounded backlog from
 * exhausting memory. Tuned too low it turns winnable requests into 429s, which
 * is why the default is generous rather than clever.
 */
const maxInFlight = Number(process.env.MAX_IN_FLIGHT ?? 8192);
let inFlight = 0;

export function inFlightCount(): number {
  return inFlight;
}
export function inFlightLimit(): number {
  return maxInFlight;
}

export async function withAdmission<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= maxInFlight) {
    inc('eventbooker_load_shed_total');
    throw new OverloadedError(`in-flight limit ${maxInFlight} reached`);
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}
