import type { RcaCategory } from "./schemas.js";

export interface FaultDef {
  id: string;
  title: string;
  description: string;
  /** Part of the MVP demo set shown in the UI. */
  mvp: boolean;
  /** Config patch hot-applied to demo-shop (deep-merged into runtime config). */
  configPatch: Record<string, unknown>;
  /** Simulated commit the agent should find in git history (a real unified diff). */
  commit: { message: string; files: string[]; diff: string };
  symptom: string;
  expected: {
    category: RcaCategory;
    /** RCA summary/evidence should mention at least 2 of these. */
    keywords: string[];
    /** A correct fix touches at least one of these files (exact path or pattern). */
    files: Array<string | RegExp>;
    /** Optional: a changed file's content must match this (e.g. the migration must recreate the index). */
    contentMatch?: RegExp;
    fixHint: string;
  };
  /** Which SLO the detector watches. `route` scopes p95 to one route. */
  slo: { metric: "errorRate" | "p95Ms" | "rssMb" | "rate429"; threshold: number; route?: string };
}

const jsonDiff = (key: string, from: string, to: string, ctx: string) => `diff --git a/config/prod.json b/config/prod.json
--- a/config/prod.json
+++ b/config/prod.json
@@ ${ctx} @@
-    "${key}": ${from},
+    "${key}": ${to},`;

export const FAULTS: FaultDef[] = [
  {
    id: "F1",
    title: "Bad config push",
    description: "payments.timeoutMs 2000 → 50",
    mvp: true,
    configPatch: { payments: { timeoutMs: 50 } },
    commit: {
      message: "chore: tune payment timeout",
      files: ["config/prod.json"],
      diff: jsonDiff("timeoutMs", "2000", "50", '-2,3 +2,3 @@ "payments": {'),
    },
    symptom: "/checkout 5xx > 5% (504 from payments)",
    expected: { category: "config", keywords: ["timeout", "payments", "50", "2000"], files: ["config/prod.json"], fixHint: "revert payments.timeoutMs to 2000" },
    slo: { metric: "errorRate", threshold: 0.05 },
  },
  {
    id: "F2",
    title: "Dropped index",
    description: "migration drops orders(user_id) index on a 500k-row table",
    mvp: true,
    configPatch: { db: { ordersIndex: false } },
    commit: {
      message: "db: drop unused index on orders",
      files: ["migrations/0007_drop_unused_index.sql"],
      diff: `diff --git a/migrations/0007_drop_unused_index.sql b/migrations/0007_drop_unused_index.sql
new file mode 100644
--- /dev/null
+++ b/migrations/0007_drop_unused_index.sql
@@ -0,0 +1,2 @@
+-- index looks unused in pg_stat_user_indexes (stats were reset yesterday)
+DROP INDEX IF EXISTS shop_orders_user_id_idx;`,
    },
    symptom: "/orders p95 > 25ms (indexed baseline ~2ms), slow-query logs show seq scan on shop_orders",
    expected: {
      category: "db",
      keywords: ["index", "user_id", "orders", "seq scan", "0007"],
      // any NEW forward migration (0008+) that recreates the index; editing an applied migration doesn't fix prod
      files: [/^migrations\/(000[8-9]|00[1-9]\d|0[1-9]\d\d)_[\w.-]+\.sql$/],
      contentMatch: /create\s+index[\s\S]*shop_orders[\s\S]*user_id/i,
      fixHint: "CREATE INDEX shop_orders_user_id_idx ON shop_orders(user_id) in a new migration",
    },
    // measured on the dev box: indexed p95 ≈2 ms; without the index every request seq-scans 106 MB → p95 ≈40 ms (cached)
    slo: { metric: "p95Ms", threshold: 25, route: "/orders" },
  },
  {
    id: "F4",
    title: "Feature flag bad deploy",
    description: "flags.newPricing false → true (TypeError on null coupon)",
    mvp: true,
    configPatch: { flags: { newPricing: true } },
    commit: {
      message: "feat: enable new pricing",
      files: ["config/prod.json"],
      diff: jsonDiff("newPricing", "false", "true", '-8,3 +8,3 @@ "flags": {'),
    },
    symptom: "/checkout 500 TypeError: Cannot read properties of null (reading 'percentOff')",
    expected: {
      category: "code",
      keywords: ["newPricing", "coupon", "null", "percentOff", "pricing.ts"],
      files: ["src/lib/pricing.ts", "config/prod.json"],
      fixHint: "null-guard coupon in src/lib/pricing.ts (and/or flag off)",
    },
    slo: { metric: "errorRate", threshold: 0.05 },
  },
  {
    id: "F7",
    title: "Rate-limit misconfig",
    description: "ratelimit.rpm 6000 → 10",
    mvp: false,
    configPatch: { ratelimit: { rpm: 10 } },
    commit: {
      message: "security: tighten rate limit",
      files: ["config/prod.json"],
      diff: jsonDiff("rpm", "6000", "10", '-16,3 +16,3 @@ "ratelimit": {'),
    },
    symptom: "429 rate > 30%",
    expected: { category: "config", keywords: ["ratelimit", "rpm", "429", "6000"], files: ["config/prod.json"], fixHint: "restore ratelimit.rpm to 6000" },
    slo: { metric: "rate429", threshold: 0.3 },
  },
];

export const getFault = (id: string) => FAULTS.find((f) => f.id === id);

/** Baseline config for demo-shop. Also the "config/prod.json" of the target repo. */
export const BASE_SHOP_CONFIG = {
  payments: { timeoutMs: 2000, latencyMs: 120, retries: 2 },
  cache: { maxEntries: 1000, keyIncludesRequestId: false },
  flags: { newPricing: false },
  inventory: { latencyMs: 40, timeoutMs: 800 as number | null },
  db: { poolMax: 20, queryMs: 15, ordersIndex: true },
  ratelimit: { rpm: 6000 },
  logging: { level: "info" },
};
export type ShopConfig = typeof BASE_SHOP_CONFIG;

/** Grade a submitted fix against the fault's expected answer (deterministic, no model). */
export function gradeFix(
  fault: FaultDef,
  fix: { category: string; text: string; culpritSha?: string; files: string[]; contents?: string[] },
  actualSha?: string,
) {
  const hay = fix.text.toLowerCase();
  const keywordHits = fault.expected.keywords.filter((k) => hay.includes(k.toLowerCase()));
  const categoryMatch = fix.category === fault.expected.category || (fault.id === "F4" && fix.category === "config");
  const norm = fix.files.map((f) => f.replace(/^\.?\//, ""));
  const fileMatch =
    norm.some((f) => fault.expected.files.some((e) => (typeof e === "string" ? e === f : e.test(f)))) &&
    (!fault.expected.contentMatch || (fix.contents ?? []).some((c) => fault.expected.contentMatch!.test(c)));
  const shaMatch = !actualSha || !fix.culpritSha || actualSha.startsWith(fix.culpritSha.slice(0, 7));
  return { correct: categoryMatch && keywordHits.length >= 2 && fileMatch && shaMatch, categoryMatch, keywordHits, fileMatch };
}
