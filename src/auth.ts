import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export interface Principal {
  userId: string;
  role: 'user' | 'admin';
}

const b64url = (b: Buffer) => b.toString('base64url');
const sign = (data: string) => b64url(createHmac('sha256', config.jwtSecret).update(data).digest());

export function issueToken(userId: string, role: 'user' | 'admin' = 'user', ttl = config.tokenTtlSeconds): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({ sub: userId, role, iat: now, exp: now + ttl })));
  const body = `${header}.${payload}`;
  return `${body}.${sign(body)}`;
}

export type VerifyResult = { ok: true; principal: Principal } | { ok: false; reason: string };

export function verifyToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [header, payload, signature] = parts;

  const expected = Buffer.from(sign(`${header}.${payload}`));
  const given = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad signature' };
  }

  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed claims' };
  }

  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'missing subject' };
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'token expired' };
  }
  return { ok: true, principal: { userId: claims.sub, role: claims.role === 'admin' ? 'admin' : 'user' } };
}

export function bearerFrom(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : null;
}

/**
 * Constant-time comparison for the admin bootstrap secret. This is the only
 * credential that is not a signed token, so it never identifies a user -- it
 * exists purely to mint admin tokens and to gate show creation.
 */
export function isAdminSecret(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
