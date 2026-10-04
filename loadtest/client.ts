/**
 * Minimal keep-alive HTTP client built on node:http(s).
 *
 * Deliberately not `fetch`: we need explicit control over socket count so the
 * load generator is the thing under our control and the server is the thing
 * under test. Global fetch will happily open unbounded connections and then we
 * end up measuring the client's meltdown instead of the server's.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface Response {
  status: number;
  body: any;
  raw: string;
  ms: number;
}

export class Client {
  private readonly base: URL;
  private readonly agent: http.Agent | https.Agent;
  private readonly lib: typeof http | typeof https;

  constructor(baseUrl: string, maxSockets = 256) {
    this.base = new URL(baseUrl);
    const secure = this.base.protocol === 'https:';
    this.lib = secure ? https : http;
    const Agent = secure ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets, timeout: 60_000 });
  }

  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const started = performance.now();

    return new Promise((resolve, reject) => {
      const req = this.lib.request(
        {
          protocol: this.base.protocol,
          hostname: this.base.hostname,
          port: this.base.port || (this.base.protocol === 'https:' ? 443 : 80),
          path,
          method,
          agent: this.agent,
          headers: {
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: any = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              /* non-JSON bodies are reported as-is via `raw` */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, raw, ms: performance.now() - started });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(60_000, () => req.destroy(new Error('client timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  get = (p: string, h?: Record<string, string>) => this.request('GET', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.request('POST', p, b, h);

  auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async token(userId: string): Promise<string> {
    const r = await this.post('/auth/token', { user_id: userId });
    if (r.status !== 200) throw new Error(`token mint failed for ${userId}: ${r.status} ${r.raw}`);
    return r.body.token;
  }

  destroy() {
    this.agent.destroy();
  }
}

/** Runs `total` tasks with at most `concurrency` in flight. */
export async function pool<T>(total: number, concurrency: number, task: (i: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(total);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      results[i] = await task(i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export const fmt = (n: number) => n.toLocaleString('en-US');
