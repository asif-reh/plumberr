import pino from "pino";

export interface LogLine {
  ts: string;
  level: "trace" | "debug" | "info" | "warn" | "error";
  msg: string;
  route?: string;
  status?: number;
  err?: string;
  [k: string]: unknown;
}

const RING_MAX = 2000;
const ring: LogLine[] = [];
const base = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: "demo-shop" } });

function push(level: LogLine["level"], msg: string, fields: Record<string, unknown> = {}) {
  const line: LogLine = { ts: new Date().toISOString(), level, msg, ...fields };
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
  base[level](fields, msg);
}

export const log = {
  info: (msg: string, f?: Record<string, unknown>) => push("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => push("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => push("error", msg, f),
};

export function queryLogs(opts: { level?: string; q?: string; sinceMinutes?: number; limit?: number }) {
  const since = Date.now() - (opts.sinceMinutes ?? 15) * 60_000;
  const order = ["trace", "debug", "info", "warn", "error"];
  const minLevel = opts.level ? order.indexOf(opts.level) : 0;
  const matches = ring.filter(
    (l) =>
      Date.parse(l.ts) >= since &&
      order.indexOf(l.level) >= minLevel &&
      (!opts.q || JSON.stringify(l).toLowerCase().includes(opts.q.toLowerCase())),
  );
  // collapse duplicates (same level+msg+err) with counts — compact for the LLM
  const groups = new Map<string, { count: number; first: string; last: string; sample: LogLine }>();
  for (const l of matches) {
    const key = `${l.level}|${l.msg}|${l.err ?? ""}|${l.route ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.last = l.ts;
    } else groups.set(key, { count: 1, first: l.ts, last: l.ts, sample: l });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.min(opts.limit ?? 50, 100));
}
