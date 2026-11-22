#!/usr/bin/env node
// Cerebras queue benchmark: N sequential chat completions per reasoning_effort, p50/p95 of
// queue_time, completion_time and wall, plus generation-only tok/s (completion_tokens / completion_time).
// Usage: node scripts/bench-queue.mjs [--n 10] [--efforts low,max] [--base https://api.cerebras.ai/v1]
// Never prints the API key. 429s are retried with backoff and counted separately (not in percentiles).
import { readFileSync, existsSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.CEREBRAS_API_KEY;
if (!KEY) { console.error("CEREBRAS_API_KEY not set"); process.exit(1); }
const BASE = (args.base ?? process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1").replace(/\/$/, "");
const MODEL = process.env.CEREBRAS_MODEL_ID ?? "moonshotai-kimi-k3.1-pro-trial";
const N = Number(args.n ?? 10);
const EFFORTS = (args.efforts ?? "low,max").split(",");
const MAX_RETRIES = Number(args.retries ?? 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : NaN; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

let printedRaw = false;
async function one(effort) {
  let r429 = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, reasoning_effort: effort, max_completion_tokens: 512,
        messages: [{ role: "user", content: "In one sentence: why can a 50ms payment timeout cause 504s?" }],
      }),
      signal: AbortSignal.timeout(600_000),
    }).catch((e) => ({ status: 0, err: e }));
    const wall = (performance.now() - t0) / 1000;
    if (res.status === 200) {
      const j = await res.json();
      if (!printedRaw) { console.log("raw time_info (first OK call):", JSON.stringify(j.time_info), "usage:", JSON.stringify(j.usage)); printedRaw = true; }
      return { ok: true, r429, wall, ti: j.time_info ?? {}, usage: j.usage ?? {} };
    }
    if (res.status === 429 || res.status >= 500 || res.status === 0) {
      r429 += res.status === 429 ? 1 : 0;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500);
      continue;
    }
    return { ok: false, r429, status: res.status };
  }
  return { ok: false, r429, status: 429 };
}

console.log(`bench-queue model=${MODEL} n=${N} efforts=${EFFORTS.join(",")} base=${BASE}`);
const summary = [];
for (const effort of EFFORTS) {
  const rows = [];
  let rejected = 0;
  for (let i = 0; i < N; i++) {
    const r = await one(effort);
    rejected += r.r429;
    if (!r.ok) { console.log(`  [${effort} ${i + 1}/${N}] FAILED status=${r.status}`); continue; }
    const q = r.ti.queue_time ?? NaN, c = r.ti.completion_time ?? NaN, ct = r.usage.completion_tokens ?? NaN;
    rows.push({ q, c, wall: r.wall, tps: ct / c });
    console.log(`  [${effort} ${i + 1}/${N}] queue=${f(q)}s completion=${f(c, 3)}s wall=${f(r.wall)}s tokens=${ct} gen=${f(ct / c, 0)} tok/s 429s=${r.r429}`);
  }
  const col = (k) => rows.map((r) => r[k]).filter(Number.isFinite);
  summary.push({
    effort, ok: rows.length, rejected429: rejected,
    queue_p50: f(pct(col("q"), 0.5)), queue_p95: f(pct(col("q"), 0.95)),
    completion_p50: f(pct(col("c"), 0.5), 3), completion_p95: f(pct(col("c"), 0.95), 3),
    wall_p50: f(pct(col("wall"), 0.5)), wall_p95: f(pct(col("wall"), 0.95)),
    gen_tps_p50: f(pct(col("tps"), 0.5), 0),
  });
}
console.log("\nseconds (time_info) — 429-rejected attempts excluded from percentiles");
console.table(summary);
