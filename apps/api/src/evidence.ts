import type { AlertPayload, ShopStats } from "@plumberr/shared/schemas";
import { shop } from "./shop.js";

/**
 * Deterministic evidence collector: everything the agent would otherwise fetch with 3–4 tool calls
 * (each one costing a full Cerebras queue wait) is gathered here in ~100ms and embedded in the page.
 */
interface Commit { sha: string; author: string; message: string; files: string[]; timestamp: string; diff?: string }
interface LogGroup { count: number; first: string; last: string; sample: Record<string, unknown> }
export interface StepResult { step: string; ms: number; bytes: number; summary: string }

const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));

async function step<T>(name: string, fn: () => Promise<T>, summarize: (v: T) => string, out: StepResult[], onStep?: (s: StepResult) => Promise<void>) {
  const t = performance.now();
  const v = await fn();
  const s = { step: name, ms: Math.round(performance.now() - t), bytes: bytes(v), summary: summarize(v) };
  out.push(s);
  await onStep?.(s);
  return v;
}

export async function collectEvidence(opts: {
  alert: AlertPayload;
  baseline: ShopStats | null;
  maxBytes: number;
  onStep?: (s: StepResult) => Promise<void>;
}) {
  const steps: StepResult[] = [];

  const commits = await step(
    "git.recent_commits",
    async () => {
      const list = (await shop<Commit[]>("/internal/commits?sinceMinutes=1440")).slice(0, 3);
      return Promise.all(list.map(async (c) => ({ ...c, diff: (await shop<Commit>(`/internal/commits/${c.sha}`)).diff ?? "" })));
    },
    (v) => `${v.length} commits: ${v.map((c) => `${c.sha.slice(0, 7)} ${c.message}`).join("; ")}`,
    steps,
    opts.onStep,
  );

  const metrics = await step(
    "metrics.summary",
    async () => {
      const now = await shop<ShopStats>("/internal/stats");
      return { now, baseline: opts.baseline };
    },
    (v) => `errorRate ${v.now.errorRate} · p95 ${v.now.p95Ms}ms · 429 ${v.now.rate429}`,
    steps,
    opts.onStep,
  );

  const logs = await step(
    "logs.top_errors",
    async () => (await shop<LogGroup[]>("/internal/logs?level=warn&sinceMinutes=10&limit=8")).slice(0, 6),
    (v) => `${v.length} deduped groups, top: ${String(v[0]?.sample.msg ?? "none")} ×${v[0]?.count ?? 0}`,
    steps,
    opts.onStep,
  );

  // files: live config + anything referenced by stack traces or touched by the suspect commits
  const wanted = new Set<string>(["config/prod.json"]);
  for (const g of logs) for (const f of JSON.stringify(g.sample).matchAll(/((?:src|config|migrations)\/[\w./-]+\.(?:ts|json|sql))/g)) wanted.add(f[1]!);
  for (const c of commits) for (const f of c.files) wanted.add(f);
  const files = await step(
    "repo.read_files",
    async () => {
      const out: Array<{ path: string; content: string }> = [];
      for (const path of [...wanted].slice(0, 4)) {
        const r = await shop<{ content: string }>(`/internal/file?path=${encodeURIComponent(path)}`).catch(() => null);
        if (r) out.push({ path, content: r.content });
      }
      return out;
    },
    (v) => v.map((f) => f.path).join(", "),
    steps,
    opts.onStep,
  );

  const text = renderBundle({ alert: opts.alert, metrics, commits, logs, files, maxBytes: opts.maxBytes });
  return { text, bytes: bytes(text), steps };
}

/* ── rendering: per-section byte budgets; every outside-sourced string is truncated THEN wrapped ── */
export const BUDGET = { commits: 4200, logs: 2000, metrics: 900, files: 850 };
const CLOSE = /<\/?untrusted>/gi;
/** Escape any (open/close) tag inside untrusted text so it can never terminate the fence. */
export const untrusted = (s: string, max: number) => `<untrusted>${cut(s, max).replace(CLOSE, (m) => m.replace("<", "&lt;"))}</untrusted>`;
function cut(s: string, max: number) {
  if (Buffer.byteLength(s) <= max) return s;
  let out = s.slice(0, max);
  while (Buffer.byteLength(out) > max - 12) out = out.slice(0, -16);
  return `${out}…[truncated]`;
}
const fit = (parts: string[], max: number) => {
  const out: string[] = [];
  let used = 0;
  for (const p of parts) {
    const b = Buffer.byteLength(p) + 1;
    if (used + b > max) break;
    out.push(p);
    used += b;
  }
  return out.join("\n");
};

function renderBundle(x: {
  alert: AlertPayload; metrics: { now: ShopStats; baseline: ShopStats | null };
  commits: Commit[]; logs: LogGroup[]; files: Array<{ path: string; content: string }>; maxBytes: number;
}) {
  // commits: newest 3, each gets an equal share of the 4.2 KB budget (msg + diff)
  const per = Math.floor(BUDGET.commits / Math.max(1, Math.min(3, x.commits.length))) - 420;
  const commits = x.commits.slice(0, 3).map(
    (c) => `- sha=${c.sha} author=${c.author} ts=${c.timestamp} files=${c.files.join(",")}\n  message: ${untrusted(c.message, 200)}\n  diff:\n${untrusted(c.diff ?? "", Math.max(200, per))}`,
  );
  // logs: deduped groups, errors first, then by count
  const rank = (g: LogGroup) => (g.sample.level === "error" ? 0 : 1);
  const logs = [...x.logs].sort((a, b) => rank(a) - rank(b) || b.count - a.count).map((g) => {
    const { ts: _t, service: _s, requestId: _r, level, msg, ...rest } = g.sample as Record<string, unknown>;
    return `- [${String(level)}] ×${g.count} ${g.first}..${g.last} ${untrusted(`${String(msg)} ${JSON.stringify(rest)}`, 420)}`;
  });
  const m = (s: ShopStats | null) =>
    s ? `rps=${s.rps} errorRate=${s.errorRate} rate429=${s.rate429} p95Ms=${s.p95Ms} routeP95=${JSON.stringify(s.routeP95 ?? {})} rssMb=${s.rssMb}` : "n/a";
  // files get their 850 B floor plus whatever commits/logs/metrics left unused of the total budget
  const used = Buffer.byteLength(fit(commits, BUDGET.commits)) + Buffer.byteLength(fit(logs, BUDGET.logs)) + BUDGET.metrics + 400;
  const filesBudget = Math.max(BUDGET.files, x.maxBytes - used);
  const per2 = Math.floor(filesBudget / Math.max(1, x.files.length)) - 60;
  const compact = (f: { path: string; content: string }) => {
    if (!f.path.endsWith(".json")) return f.content;
    try { return JSON.stringify(JSON.parse(f.content)); } catch { return f.content; }
  };
  const files = x.files.map((f) => `- ${f.path}:\n${untrusted(compact(f), Math.max(150, per2))}`);
  // Never cut the assembled text (that could split a fence): drop whole items instead until it fits.
  const render = () =>
    [
      `## alert\n${x.alert.alertName} ${x.alert.metric}=${x.alert.value} threshold=${x.alert.threshold} at ${x.alert.startedAt}`,
      `## metrics (30s window)\n${cut(`now: ${m(x.metrics.now)}\nbaseline (pre-incident): ${m(x.metrics.baseline)}`, BUDGET.metrics)}`,
      `## recent commits (newest first)\n${fit(commits, BUDGET.commits)}`,
      `## top warn/error logs (deduped, errors first)\n${fit(logs, BUDGET.logs)}`,
      `## files\n${fit(files, filesBudget)}`,
    ].join("\n\n");
  let out = render();
  while (Buffer.byteLength(out) > x.maxBytes && (files.length || logs.length > 1)) {
    if (files.length) files.pop();
    else logs.pop();
    out = render();
  }
  return out;
}
