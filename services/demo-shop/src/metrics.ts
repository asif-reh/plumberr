import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests",
  labelNames: ["route", "method", "status"] as const,
  registers: [registry],
});
export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["route", "method", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 2, 5],
  registers: [registry],
});
export const cacheEntries = new client.Gauge({ name: "shop_cache_entries", help: "Cache entries", registers: [registry] });
export const poolWaiting = new client.Gauge({ name: "shop_db_pool_waiting", help: "Waiting for DB connection", registers: [registry] });

/** Rolling window used by /internal/stats (and the api's in-process detector). */
interface Sample { t: number; ms: number; status: number; route: string }
const WINDOW_MS = 30_000;
const samples: Sample[] = [];
export function record(ms: number, status: number, route = "") {
  const t = Date.now();
  samples.push({ t, ms, status, route });
  while (samples.length && samples[0]!.t < t - WINDOW_MS) samples.shift();
}
export const clearSamples = () => { samples.length = 0; };
export function stats() {
  const now = Date.now();
  const win = samples.filter((s) => s.t >= now - WINDOW_MS);
  const n = win.length || 1;
  const sorted = win.map((s) => s.ms).sort((a, b) => a - b);
  const p95 = pct(sorted);
  const byRoute = new Map<string, number[]>();
  for (const s of win) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s.ms]);
  const routeP95 = Object.fromEntries([...byRoute].map(([r, v]) => [r, Math.round(pct(v.sort((a, b) => a - b)))]));
  return {
    windowSec: WINDOW_MS / 1000,
    rps: +(win.length / (WINDOW_MS / 1000)).toFixed(2),
    errorRate: +(win.filter((s) => s.status >= 500).length / n).toFixed(4),
    rate429: +(win.filter((s) => s.status === 429).length / n).toFixed(4),
    p95Ms: Math.round(p95),
    routeP95,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

function pct(sorted: number[], q = 0.95) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : 0;
}
