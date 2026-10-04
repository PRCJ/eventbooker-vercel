/**
 * Runs every suite against one target and exits non-zero if anything fails.
 * Point it at a deployment to prove the live service, not just the code:
 *
 *   npm run verify -- --url https://your-app.vercel.app --admin <ADMIN_TOKEN>
 *
 * The storm is sized down by default for a remote target, where the network,
 * not the service, is the bottleneck. Override with --requests / --concurrency.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const url = arg('url') ?? process.env.API_URL ?? 'http://localhost:3000';
const admin = arg('admin') ?? process.env.ADMIN_TOKEN ?? 'dev-only-admin-token';
const remote = !/localhost|127\.0\.0\.1/.test(url);

const requests = arg('requests', remote ? '3000' : '20000')!;
const concurrency = arg('concurrency', remote ? '200' : '1000')!;

const suites: Array<[string, string[]]> = [
  ['functional conformance', ['loadtest/api_test.ts', '--url', url, '--admin', admin]],
  ['adversarial races', ['loadtest/races.ts', '--url', url, '--admin', admin, '--rounds', arg('rounds', '25')!]],
  ['single hot seat (500 buyers, 1 seat)', ['loadtest/storm.ts', '--url', url, '--admin', admin,
    '--requests', '500', '--concurrency', '500', '--hot-seats', '1', '--hot-share', '1',
    '--retry-rate', '0', '--hall', '100', '--users', '500']],
  ['stampede', ['loadtest/storm.ts', '--url', url, '--admin', admin,
    '--requests', requests, '--concurrency', concurrency]],
];

const run = (args: string[]) =>
  new Promise<number>((res) => {
    const p = spawn('npx', ['tsx', ...args], { cwd: root, stdio: 'inherit' });
    p.on('close', (code) => res(code ?? 1));
  });

const failed: string[] = [];
console.log(`\x1b[1mverifying ${url}\x1b[0m\n`);
for (const [name, args] of suites) {
  console.log(`\n\x1b[1m${'='.repeat(70)}\n${name}\n${'='.repeat(70)}\x1b[0m`);
  if ((await run(args)) !== 0) failed.push(name);
}

console.log(`\n${'='.repeat(70)}`);
if (failed.length) {
  console.log(`\x1b[31mFAILED: ${failed.join(', ')}\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall suites passed against ${url}\x1b[0m`);
