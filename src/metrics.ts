/**
 * A tiny Prometheus exposition layer.
 *
 * Deliberately no prom-client: on serverless, in-process counters are per
 * instance and reset on every cold start, so they cannot be the source of truth
 * for "did we sell a seat twice". The numbers that matter -- seats by status,
 * reservations by outcome, money captured -- are computed from the database on
 * scrape, which makes them exact no matter how many instances are running. The
 * in-process counters below are only for traffic shape and latency.
 */

type Labels = Record<string, string>;

const counters = new Map<string, number>();
const histograms = new Map<string, { buckets: number[]; counts: number[]; sum: number; count: number }>();

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const processStartedAt = Date.now();

function key(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(String(labels[k]))}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

export function inc(name: string, labels: Labels = {}, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function observe(name: string, labels: Labels, seconds: number): void {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { buckets: LATENCY_BUCKETS, counts: new Array(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
    histograms.set(k, h);
  }
  h.sum += seconds;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) if (seconds <= h.buckets[i]) h.counts[i]++;
}

function splitKey(k: string): { name: string; labels: string } {
  const i = k.indexOf('{');
  return i === -1 ? { name: k, labels: '' } : { name: k.slice(0, i), labels: k.slice(i) };
}

function withLabel(labels: string, extra: string): string {
  if (!labels) return `{${extra}}`;
  return `${labels.slice(0, -1)},${extra}}`;
}

export function renderProcessMetrics(): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const [k, v] of counters) {
    const { name } = splitKey(k);
    if (!seen.has(name)) {
      lines.push(`# TYPE ${name} counter`);
      seen.add(name);
    }
    lines.push(`${k} ${v}`);
  }

  for (const [k, h] of histograms) {
    const { name, labels } = splitKey(k);
    if (!seen.has(name)) {
      lines.push(`# TYPE ${name} histogram`);
      seen.add(name);
    }
    let cumulative = 0;
    for (let i = 0; i < h.buckets.length; i++) {
      cumulative = h.counts[i];
      lines.push(`${name}_bucket${withLabel(labels, `le="${h.buckets[i]}"`)} ${cumulative}`);
    }
    lines.push(`${name}_bucket${withLabel(labels, 'le="+Inf"')} ${h.count}`);
    lines.push(`${name}_sum${labels} ${h.sum}`);
    lines.push(`${name}_count${labels} ${h.count}`);
  }

  lines.push('# TYPE eventbooker_process_uptime_seconds gauge');
  lines.push(`eventbooker_process_uptime_seconds ${(Date.now() - processStartedAt) / 1000}`);
  return lines.join('\n');
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}
