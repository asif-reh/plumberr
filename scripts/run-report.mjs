#!/usr/bin/env node
// Summarise one Plumberr incident: timeline timers, tool calls, and per-model-call
// Cerebras queue vs generation time (from OpenClaw gateway log + raw stream).
//   node scripts/run-report.mjs <incidentId> [gatewayLog] [rawStreamJsonl]
import { readFileSync, existsSync } from "node:fs";

const [id, gwLog = "/tmp/pl/gateway.log", raw = "/tmp/plumberr-raw-stream.jsonl"] = process.argv.slice(2);
if (!id) { console.error("usage: run-report.mjs <incidentId> [gatewayLog] [rawStream]"); process.exit(1); }
const API = process.env.API_URL ?? "http://localhost:4000";
const { incident, events } = await (await fetch(`${API}/incidents/${id}`)).json();
const t = (s) => (s ? Date.parse(s) : null);
const sec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const [c, a, r, p] = [t(incident.createdAt), t(incident.alertedAt), t(incident.rootCausedAt), t(incident.prOpenedAt)];
const end = p ?? r ?? Date.now();

// model calls from the gateway log (hook/cron sessions only)
const calls = [];
if (existsSync(gwLog)) {
  for (const line of readFileSync(gwLog, "latin1").split("\n")) {
    const m = line.match(/^(\S+) \[provider-transport-fetch\] \[model-fetch\] (start|response) .*?(?:status=(\d+))?.*?sessionKey="([^"]+)" runId="([^"]+)" requestId="([^"]+)"/);
    if (!m || !m[4].includes(":cron:")) continue;
    const ts = Date.parse(m[1]);
    if (ts < (a ?? c) - 1000 || ts > end + 120_000) continue;
    if (m[2] === "start") calls.push({ runId: m[5], requestId: m[6], start: ts });
    else {
      const call = calls.find((x) => x.requestId === m[6]);
      if (call) { call.status = Number(line.match(/status=(\d+)/)?.[1]); call.headers = ts; }
    }
  }
}
// first token / message end from raw stream
const rawEvents = existsSync(raw)
  ? readFileSync(raw, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
for (const call of calls.filter((x) => x.status === 200)) {
  const evs = rawEvents.filter((e) => e.runId === call.runId && e.ts >= call.start).sort((x, y) => x.ts - y.ts);
  const first = evs.find((e) => /_delta|_start/.test(e.evtType ?? ""));
  const done = evs.find((e) => e.event === "assistant_message_end" && e.ts >= (first?.ts ?? 0));
  call.firstToken = first?.ts; call.end = done?.ts;
}
const ok = calls.filter((x) => x.status === 200);
const queueMs = ok.reduce((s, x) => s + ((x.firstToken ?? x.end ?? x.start) - x.start), 0);
const genMs = ok.reduce((s, x) => s + (x.end && x.firstToken ? x.end - x.firstToken : 0), 0);
const toolCalls = events.filter((e) => e.kind === "agent.tool_call");

console.log(`\n🔧 Plumberr incident ${incident.id} — fault ${incident.faultId} — status ${incident.status}`);
console.log(`  detect (break→alert):        ${sec(a && a - c)}`);
console.log(`  time to root cause (page→RCA): ${sec(a && r && r - a)}`);
console.log(`  time to fix PR (page→PR):     ${sec(a && p && p - a)}`);
console.log(`  total (break→PR):             ${sec(p && p - c)}`);
console.log(`  model calls: ${ok.length} ok, ${calls.length - ok.length} rejected (429/other)`);
console.log(`  Cerebras queue+prefill: ${sec(queueMs)}   generation: ${sec(genMs)}`);
for (const [i, x] of ok.entries()) console.log(`    call ${i + 1}: queue ${sec((x.firstToken ?? x.start) - x.start)}  gen ${sec(x.end && x.firstToken ? x.end - x.firstToken : null)}`);
console.log(`  tool calls: ${toolCalls.length} → ${toolCalls.map((e) => `${e.data?.tool}${e.data?.ok === false ? "✗" : ""}`).join(", ")}`);
if (incident.rca) console.log(`  RCA [${incident.rca.category}] (${Math.round(incident.rca.confidence * 100)}%): ${incident.rca.summary}`);
if (incident.prUrl) console.log(`  PR: ${incident.prUrl}`);
