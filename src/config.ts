function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://localhost:5432/eventbooker'),

  // Dev default exists so `npm run dev` works out of the box; production refuses
  // to start without a real secret (see assertProductionSafety).
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret',
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-only-admin-token',
  tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS ?? 24 * 3600),

  defaultPerUserLimit: Number(process.env.DEFAULT_PER_USER_LIMIT ?? 4),
  maxSeatsPerShow: Number(process.env.MAX_SEATS_PER_SHOW ?? 100_000),
  maxSeatsPerRequest: Number(process.env.MAX_SEATS_PER_REQUEST ?? 16),

  // Bounded on purpose. Under a 20k burst the right move is to queue inside the
  // process and keep Postgres at a connection count it can actually schedule;
  // an unbounded pool just moves the pileup somewhere less observable.
  pgPoolMax: Number(process.env.PG_POOL_MAX ?? 40),
  // Short enough that a stuck query frees its connection well inside Vercel's
  // 15s function ceiling, even after the retry budget is spent.
  statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS ?? 3000),

  port: Number(process.env.PORT ?? 3000),
  isVercel: Boolean(process.env.VERCEL),
  nodeEnv: process.env.NODE_ENV ?? 'development',
};

export function assertProductionSafety(): void {
  if (config.nodeEnv !== 'production') return;
  if (config.jwtSecret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET must be set to a real secret in production');
  }
  if (config.adminToken.startsWith('dev-only')) {
    throw new Error('ADMIN_TOKEN must be set to a real secret in production');
  }
}
