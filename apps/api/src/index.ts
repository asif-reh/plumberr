import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { FAULTS, getFault } from "@plumberr/shared/faults";
import {
  AgentHookEvent, AlertPayload, BreakRequest, LlmCallRecord, SubmitFixRequest, TimelineEventInput,
  type Incident, type TimelineEvent,
} from "@plumberr/shared/schemas";
import { verifySignature } from "@plumberr/shared";
import { env } from "./env.js";
import { memoryStore, postgresStore } from "./store.js";
import { createBus } from "./bus.js";
import { createCoord } from "./lock.js";
import { createRunner } from "./runner.js";
import { shop } from "./shop.js";

const store = env.databaseUrl ? postgresStore(env.databaseUrl) : memoryStore();
const bus = createBus(env.redisUrl);
const coord = createCoord(env.redisUrl);
const runner = createRunner(store, bus, coord);
const { emit } = runner;

const bearer = (c: Context) => c.req.header("authorization") ?? "";
const requireInternal = async (c: Context, next: Next) => {
  if (bearer(c) !== `Bearer ${env.internalToken}`) return c.json({ error: "unauthorized" }, 401);
  await next();
};
const clientIp = (c: Context) =>
  c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? getConnInfo(c).remote.address ?? "unknown";

const app = new Hono();
app.use("*", logger());
app.use("*", cors({ origin: env.webOrigin, allowHeaders: ["content-type", "authorization", "last-event-id"] }));

app.get("/health", async (c) =>
  c.json({
    ok: true, store: store.kind, bus: bus.kind, lock: coord.kind, lockHolder: await coord.holder(),
    shopUp: runner.stats().up, breakEnabled: env.breakEnabled, agent: env.openclawUrl ? "openclaw" : "dry-run",
  }),
);
app.get("/faults", (c) =>
  c.json(FAULTS.map(({ id, title, description, symptom, expected, mvp }) => ({ id, title, description, symptom, mvp, category: expected.category }))),
);
app.get("/shop/stats", (c) => c.json(runner.stats()));

/* ── Live Break-it: BREAK_ENABLED + per-IP rate limit + global lock (inside breakIt) ── */
app.post("/break", async (c) => {
  const owner = bearer(c) === `Bearer ${env.ownerToken}`;
  if (!env.breakEnabled && !owner) return c.json({ error: "Live mode is off — watch the replay" }, 503);
  const parsed = BreakRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "faultId required" }, 400);
  if (!getFault(parsed.data.faultId)) return c.json({ error: "unknown fault" }, 404);
  if (!owner) {
    const left = await coord.hit(`break:${clientIp(c)}`, env.breakRateLimit, env.breakRateWindowSec);
    if (left < 0) return c.json({ error: "rate limited — try again later" }, 429);
  }
  const r = await runner.breakIt(parsed.data.faultId);
  return c.json(r.body as object, r.status as 201);
});

app.post("/reset", async (c) => {
  const a = bearer(c);
  if (a !== `Bearer ${env.ownerToken}` && a !== `Bearer ${env.internalToken}` && process.env.NODE_ENV === "production") {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({ ok: true, ...(await runner.reset("manual reset")) });
});

/* ── External alert webhook (optional Grafana etc.; not in the critical path) — HMAC signed ── */
app.post("/webhooks/alert", async (c) => {
  const raw = await c.req.text();
  if (!verifySignature(env.alertSecret, raw, c.req.header("x-signature"))) return c.json({ error: "bad signature" }, 401);
  const parsed = AlertPayload.safeParse(JSON.parse(raw || "{}"));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const incident = parsed.data.incidentId ? await store.getIncident(parsed.data.incidentId) : await store.activeIncident();
  if (!incident) return c.json({ ok: true, ignored: "no active incident" });
  void runner.handleAlert(incident, { ...parsed.data, incidentId: incident.id });
  return c.json({ ok: true, incidentId: incident.id }, 202);
});

/* ── Internal API: called by the OpenClaw plugins (tools + hooks) and the Cerebras proxy ── */
const internal = new Hono();
internal.use("*", requireInternal);

// read-only agent data sources (the gateway never talks to the shop or GitHub directly)
internal.get("/agent/logs", async (c) => c.json(await shop(`/internal/logs?${new URL(c.req.url).searchParams}`)));
internal.get("/agent/metrics", async (c) => {
  const s = runner.stats();
  return c.json({ now: s.current, last60s: s.history.slice(-30).map(({ ts, errorRate, p95Ms, rate429, routeP95 }) => ({ ts, errorRate, p95Ms, rate429, routeP95 })) });
});
internal.get("/agent/commits", async (c) => c.json(await shop(`/internal/commits?sinceMinutes=${Number(c.req.query("sinceMinutes") ?? 120)}`)));
internal.get("/agent/commits/:sha", async (c) => c.json(await shop(`/internal/commits/${encodeURIComponent(c.req.param("sha") ?? "")}`)));
internal.get("/agent/file", async (c) => {
  const path = c.req.query("path") ?? "";
  if (!/^(src|config|migrations)\//.test(path) || path.includes("..")) return c.json({ error: "path not allowed" }, 403);
  return c.json(await shop(`/internal/file?path=${encodeURIComponent(path)}`).catch(() => ({ error: "not found" })));
});

internal.post("/incidents/:id/submit-fix", async (c) => {
  const parsed = SubmitFixRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  const r = await runner.submitFix(c.req.param("id") as string, parsed.data);
  return c.json(r.body as object, r.status as 200);
});

async function incidentFor(runId?: string, hint?: unknown): Promise<Incident | null> {
  if (typeof hint === "string") { const i = await store.getIncident(hint); if (i) return i; }
  if (runId) { const i = await store.byRunId(runId); if (i) return i; }
  const a = await store.activeIncident();
  return a?.alertedAt ? a : null;
}

// plumberr-hooks plugin: model_call_ended / after_tool_call / before_tool_call blocks
internal.post("/agent-events", async (c) => {
  const parsed = AgentHookEvent.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const { type, runId, data } = parsed.data;
  const inc = await incidentFor(runId, (data.params as Record<string, unknown> | undefined)?.incidentId);
  if (!inc) return c.json({ ok: true, ignored: true });
  const text =
    type === "model_call"
      ? `Model turn ${String(data.turn)} ${String(data.outcome)} in ${(Number(data.durationMs) / 1000).toFixed(1)}s (TTFB ${(Number(data.timeToFirstByteMs ?? 0) / 1000).toFixed(1)}s)`
      : type === "tool_call"
        ? `${String(data.toolName)}${data.error ? ` failed: ${String(data.error).slice(0, 200)}` : ""} (${String(data.durationMs ?? "?")}ms)`
        : `Blocked ${String(data.toolName)}: ${String(data.reason)}`;
  const kind = type === "model_call" ? "agent.model_call" : type === "tool_call" ? "agent.tool_call" : "agent.blocked";
  await emit({ incidentId: inc.id, kind, text, data: { ...data, runId, source: "agent" } });
  return c.json({ ok: true });
});

// cerebras-proxy: measured queue vs generation per completion (metadata only)
const recentLlm: Array<LlmCallRecord & { at: string }> = [];
internal.post("/llm-calls", async (c) => {
  const parsed = LlmCallRecord.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const r = parsed.data;
  recentLlm.push({ ...r, at: new Date().toISOString() });
  if (recentLlm.length > 200) recentLlm.shift();
  const inc = await incidentFor();
  if (inc && !inc.resolvedAt && r.stream) {
    const f = (ms: number | null) => (ms == null ? "?" : `${(ms / 1000).toFixed(1)}s`);
    await emit({
      incidentId: inc.id,
      kind: "agent.llm_call",
      text: `Cerebras ${r.status}: queue ${f(r.queueMs)} · gen ${f(r.generationMs)} · wall ${f(r.wallMs)} · effort=${r.reasoningEffort ?? "none"}${r.effortInjected ? " (injected)" : ""}`,
      data: { ...r, source: "agent" },
    });
  }
  return c.json({ ok: true });
});

internal.post("/timeline", async (c) => {
  const parsed = TimelineEventInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  if (!(await store.getIncident(parsed.data.incidentId))) return c.json({ error: "unknown incident" }, 404);
  const ev = await emit(parsed.data);
  return c.json({ ok: true, seq: ev.seq });
});
app.route("/internal", internal);

/* ── Read API ── */
app.get("/llm-calls/recent", (c) => c.json(recentLlm.slice(-50)));
app.get("/incidents", async (c) => c.json(await store.listIncidents()));
app.get("/incidents/active", async (c) => c.json(await store.activeIncident()));
app.get("/incidents/best", async (c) => {
  const incident = await store.best();
  if (!incident) return c.json({ incident: null, events: [] });
  return c.json({ incident, events: await store.events(incident.id) });
});
app.get("/incidents/:id", async (c) => {
  const incident = await store.getIncident(c.req.param("id"));
  if (!incident) return c.json({ error: "not found" }, 404);
  return c.json({ incident, events: await store.events(incident.id) });
});

/* ── SSE: live incident timeline with Last-Event-ID replay ── */
app.get("/incidents/:id/stream", async (c) => {
  const id = c.req.param("id") as string;
  if (!(await store.getIncident(id))) return c.json({ error: "not found" }, 404);
  const lastId = Number(c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? 0);
  return streamSSE(c, async (stream) => {
    const queued: TimelineEvent[] = [];
    let ready = false;
    let lastSent = lastId;
    const send = async (e: TimelineEvent) => {
      if (e.seq <= lastSent) return;
      lastSent = e.seq;
      const incident = await store.getIncident(id);
      await stream.writeSSE({ id: String(e.seq), event: "timeline", data: JSON.stringify({ event: e, incident }) });
    };
    const unsub = bus.subscribe((e) => {
      if (e.incidentId !== id) return;
      if (ready) void send(e); else queued.push(e);
    });
    for (const e of await store.events(id, lastId)) await send(e);
    ready = true;
    for (const e of queued) await send(e);
    const hb = setInterval(() => void stream.write(": heartbeat\n\n"), 15_000);
    await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    clearInterval(hb);
    unsub();
  });
});

app.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    const unsub = bus.subscribe((e) => void stream.writeSSE({ id: String(e.seq), event: "timeline", data: JSON.stringify(e) }));
    const hb = setInterval(() => void stream.write(": heartbeat\n\n"), 15_000);
    await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    clearInterval(hb);
    unsub();
  }),
);

await store.init();
await runner.recover();
serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[api] :${info.port} store=${store.kind} bus=${bus.kind} lock=${coord.kind} agent=${env.openclawUrl ?? "dry-run"} loadgen=${env.loadgenRps}rps`);
});
