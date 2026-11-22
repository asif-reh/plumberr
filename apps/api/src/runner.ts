import { randomUUID } from "node:crypto";
import { getFault, gradeFix, type FaultDef } from "@plumberr/shared/faults";
import type { AlertPayload, Incident, ShopStats, SubmitFixRequest, TimelineEvent, TimelineEventInput } from "@plumberr/shared/schemas";
import type { Bus } from "./bus.js";
import type { Coord } from "./lock.js";
import type { Store } from "./store.js";
import { env } from "./env.js";
import { shop } from "./shop.js";
import { collectEvidence } from "./evidence.js";
import { buildPageMessage, dispatchAgent } from "./openclaw.js";
import { openPr } from "./github.js";

/**
 * In-process incident runner (replaces apps/worker + BullMQ):
 * detector → collector (evidence bundle) → OpenClaw dispatch → submit_fix → auto-reset.
 */
export function createRunner(store: Store, bus: Bus, coord: Coord) {
  const history: ShopStats[] = [];
  let shopUp = false;
  let resetTimer: NodeJS.Timeout | null = null;
  let resetAt: number | null = null;
  const modelErrors = new Map<string, number>();
  const alerting = new Set<string>();
  const fixing = new Map<string, Promise<unknown>>();

  async function emit(e: TimelineEventInput): Promise<TimelineEvent> {
    const ev = await store.appendEvent(e);
    await bus.publish(ev);
    return ev;
  }

  /* ── shop stats sampler (dashboard sparkline + detector input + baseline) ── */
  setInterval(async () => {
    try {
      const s = await shop<ShopStats>("/internal/stats");
      shopUp = true;
      history.push(s);
      if (history.length > 150) history.shift();
    } catch { shopUp = false; }
  }, 2000).unref();

  /* ── load generator (moved from demo-shop so one service owns the demo loop) ── */
  if (env.loadgenRps > 0) {
    setInterval(() => {
      const r = Math.random();
      const base = env.shopUrl;
      const req =
        r < 0.35
          ? fetch(`${base}/products/${1 + Math.floor(Math.random() * 50)}`)
          : r < 0.7
            ? fetch(`${base}/orders?userId=${1 + Math.floor(Math.random() * 50_000)}`)
            : fetch(`${base}/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: ["1", "2"], coupon: null }) });
      req.then((res) => res.body?.cancel()).catch(() => {});
    }, 1000 / env.loadgenRps).unref();
  }

  /* ── detector: fault SLO (route-scoped when set) + global SLOs ── */
  const GLOBAL: FaultDef["slo"][] = [
    { metric: "errorRate", threshold: 0.05 },
    { metric: "p95Ms", threshold: 1500 },
    { metric: "rate429", threshold: 0.3 },
  ];
  const valueOf = (s: ShopStats, slo: FaultDef["slo"]) => (slo.route ? s.routeP95?.[slo.route] ?? 0 : Number(s[slo.metric]));
  setInterval(async () => {
    try {
      const active = await store.activeIncident();
      if (!active || active.alertedAt || active.status !== "degraded" || alerting.has(active.id)) return;
      const s = await shop<ShopStats>("/internal/stats");
      const fault = getFault(active.faultId);
      const rules = fault ? [fault.slo, ...GLOBAL] : GLOBAL;
      const hit = rules.find((r) => valueOf(s, r) > r.threshold);
      if (!hit) return;
      await handleAlert(active, {
        incidentId: active.id,
        alertName: `SLO:${hit.metric}${hit.route ? `(${hit.route})` : ""}`,
        service: "demo-shop",
        metric: hit.route ? `p95Ms{route="${hit.route}"}` : hit.metric,
        value: valueOf(s, hit),
        threshold: hit.threshold,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[detector]", (err as Error).message);
    }
  }, env.detectorIntervalMs).unref();

  async function handleAlert(incident: Incident, alert: AlertPayload) {
    if (incident.alertedAt || alerting.has(incident.id)) return { deduped: true };
    alerting.add(incident.id);
    try {
      await store.updateIncident(incident.id, { status: "alerted", alertedAt: new Date().toISOString() });
      await emit({ incidentId: incident.id, kind: "alert.fired", text: `${alert.alertName}: ${alert.metric}=${alert.value} (threshold ${alert.threshold})`, data: alert });

      // baseline = latest sample taken before the fault was injected
      const before = history.filter((h) => h.ts && Date.parse(h.ts) < Date.parse(incident.createdAt)).at(-1) ?? null;
      const t0 = performance.now();
      const { text: bundle, bytes, steps } = await collectEvidence({
        alert,
        baseline: before,
        maxBytes: env.evidenceMaxBytes,
        onStep: async (s) => {
          await emit({ incidentId: incident.id, kind: "collector.step", text: `${s.step}: ${s.summary}`, data: { ...s, source: "collector" } });
        },
      });
      await emit({
        incidentId: incident.id,
        kind: "collector.bundle",
        text: `Evidence bundle ready: ${(bytes / 1024).toFixed(1)} KB in ${Math.round(performance.now() - t0)} ms (${steps.length} steps, 0 model calls)`,
        data: { bytes, ms: Math.round(performance.now() - t0), steps: steps.map((s) => s.step), bundle, source: "collector" },
      });

      await store.updateIncident(incident.id, { status: "investigating" });
      await emit({
        incidentId: incident.id,
        kind: "agent.dispatched",
        text: env.openclawUrl ? `Paging Plumberr agent (${env.modelId} on Cerebras via OpenClaw)` : "Dry run: OPENCLAW_URL not set — agent not paged",
        data: { model: env.modelId },
      });
      const d = await dispatchAgent(incident.id, buildPageMessage(incident.id, bundle));
      if (d.runId) await store.updateIncident(incident.id, { runId: d.runId });
      await emit({ incidentId: incident.id, kind: "info", text: d.dryRun ? "Dry run: no gateway" : `OpenClaw admitted run ${d.runId}`, data: { runId: d.runId } });
      setTimeout(() => void failIncident(incident.id, `No fix within ${Math.round(env.investigateTimeoutMs / 1000)}s (model busy) — showing the replay instead; the shop auto-heals shortly.`), env.investigateTimeoutMs).unref();
      return { ok: true };
    } catch (err) {
      await store.updateIncident(incident.id, { status: "failed" });
      await emit({ incidentId: incident.id, kind: "error", text: `Alert handling failed: ${(err as Error).message}` });
      scheduleHeal(incident.id, "failure");
      return { ok: false, error: (err as Error).message };
    } finally {
      alerting.delete(incident.id);
    }
  }

  async function breakIt(faultId: string): Promise<{ status: number; body: unknown }> {
    const fault = getFault(faultId);
    if (!fault) return { status: 404, body: { error: "unknown fault" } };
    const id = `inc_${randomUUID().slice(0, 8)}`;
    if (!(await coord.acquire(id, env.autoResetMs + 60_000))) {
      return { status: 409, body: { error: "an incident is already in progress", holder: await coord.holder(), incident: await store.activeIncident() } };
    }
    const incident: Incident = {
      id, faultId: fault.id, status: "injecting", createdAt: new Date().toISOString(),
      alertedAt: null, rootCausedAt: null, prOpenedAt: null, resolvedAt: null, rca: null, prUrl: null, grade: null, runId: null,
    };
    await store.createIncident(incident);
    try {
      const res = await shop<{ commit: { sha: string } }>(`/internal/faults/${fault.id}`, { method: "POST", timeoutMs: 30_000 });
      await store.updateIncident(id, { status: "degraded" });
      await emit({ incidentId: id, kind: "fault.injected", text: `${fault.title}: ${fault.description}`, data: { faultId: fault.id, sha: res.commit.sha, files: fault.commit.files } });
    } catch (err) {
      await store.updateIncident(id, { status: "failed" });
      await emit({ incidentId: id, kind: "error", text: `fault injection failed: ${(err as Error).message}` });
      await coord.release(id);
      return { status: 502, body: { error: "fault injection failed", incidentId: id } };
    }
    scheduleAutoReset(env.autoResetMs);
    return { status: 201, body: await store.getIncident(id) };
  }

  function scheduleAutoReset(ms: number, reason = "auto-reset (10 min)") {
    if (resetTimer) clearTimeout(resetTimer);
    resetAt = Date.now() + Math.max(0, ms);
    resetTimer = setTimeout(() => void reset(reason), Math.max(0, ms));
    resetTimer.unref();
  }

  /** Auto-heal soon after the incident ends (PR opened or failed); the 10-min cap stays as fallback. */
  function scheduleHeal(id: string, why: string) {
    if (resetAt !== null && resetAt - Date.now() <= env.autoResetAfterPrMs) return; // already sooner
    scheduleAutoReset(env.autoResetAfterPrMs, `auto-heal ${Math.round(env.autoResetAfterPrMs / 1000)}s after ${why}`);
    void emit({ incidentId: id, kind: "info", text: `Auto-heal: reverting the fault and freeing Break-it in ${Math.round(env.autoResetAfterPrMs / 1000)}s` });
  }

  async function failIncident(id: string, text: string) {
    const cur = await store.getIncident(id);
    if (!cur || cur.prUrl || cur.resolvedAt || cur.status === "failed") return;
    await store.updateIncident(id, { status: "failed" });
    await emit({ incidentId: id, kind: "error", text });
    scheduleHeal(id, "failure");
  }

  /** Cerebras quota guard: count failed model calls per incident before a fix. */
  async function noteModelCall(id: string, outcome: string) {
    if (outcome === "completed") return;
    const n = (modelErrors.get(id) ?? 0) + 1;
    modelErrors.set(id, n);
    if (n >= env.maxModelErrors) {
      await failIncident(id, `Cerebras is rate-limiting right now (${n} failed model calls) — showing the replay instead; the shop auto-heals shortly.`);
    }
  }

  async function reset(reason = "manual reset") {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = null;
    resetAt = null;
    await shop("/internal/reset", { method: "POST", timeoutMs: 60_000 }).catch(() => null);
    const active = await store.activeIncident();
    if (active) {
      await store.updateIncident(active.id, { status: "resolved", resolvedAt: new Date().toISOString() });
      await emit({ incidentId: active.id, kind: "resolved", text: `Service restored to baseline (${reason})` });
    }
    const holder = await coord.holder();
    if (holder) await coord.release(holder);
    return { resolved: active?.id ?? null };
  }

  /** submit_fix: RCA timer → PR timer, idempotent per incident (concurrent calls share one promise). */
  async function submitFix(id: string, req: SubmitFixRequest) {
    const existing = await store.getIncident(id);
    if (!existing) return { status: 404, body: { error: "unknown incident" } };
    if (existing.prUrl) return { status: 200, body: { ok: true, deduped: true, prUrl: existing.prUrl, grade: existing.grade } };
    const inflight = fixing.get(id);
    if (inflight) return { status: 200, body: { ok: true, deduped: true, ...(await inflight as object) } };
    const p = (async () => {
      const rc = req.rootCause;
      await store.updateIncident(id, { status: "root_caused", rootCausedAt: new Date().toISOString(), rca: rc });
      await emit({ incidentId: id, kind: "rca.declared", text: rc.summary, data: rc });

      const fault = getFault(existing.faultId);
      const injected = (await store.events(id)).find((e) => e.kind === "fault.injected");
      const grade = fault
        ? gradeFix(fault, {
            category: rc.category,
            text: [rc.summary, ...rc.evidence, req.title, req.postmortem.rootCause ?? "", req.postmortem.fix ?? "", ...req.changes.map((c) => c.path)].join("\n"),
            culpritSha: rc.culpritSha,
            files: req.changes.map((c) => c.path),
            contents: req.changes.map((c) => c.content),
          }, injected?.data?.sha as string | undefined)
        : null;
      const body = renderPrBody(id, req);
      let pr;
      try {
        pr = await openPr({ incidentId: id, title: req.title, body, changes: req.changes });
      } catch (err) {
        await emit({ incidentId: id, kind: "error", text: `PR creation failed: ${(err as Error).message}` });
        throw err;
      }
      await store.updateIncident(id, { status: "pr_opened", prOpenedAt: new Date().toISOString(), prUrl: pr.url, grade });
      await emit({
        incidentId: id,
        kind: "pr.opened",
        text: `${pr.dryRun ? "PR prepared (dry run)" : "PR opened"}: ${req.title}`,
        data: { prUrl: pr.url, dryRun: pr.dryRun, branch: pr.branch, title: req.title, body, changes: req.changes.map((c) => ({ path: c.path, content: c.content.slice(0, 4000) })), grade },
      });
      scheduleHeal(id, "the fix PR");
      return { prUrl: pr.url, dryRun: pr.dryRun, grade };
    })();
    fixing.set(id, p);
    try {
      return { status: 200, body: { ok: true, ...(await p) } };
    } catch (err) {
      return { status: 502, body: { error: (err as Error).message } };
    } finally {
      fixing.delete(id);
    }
  }

  /** On boot: re-arm auto-reset for an incident left active by a previous process. */
  async function recover() {
    const active = await store.activeIncident();
    if (!active) return;
    const left = Date.parse(active.createdAt) + env.autoResetMs - Date.now();
    await coord.acquire(active.id, Math.max(left, 1000) + 60_000);
    scheduleAutoReset(left);
  }

  return {
    emit, handleAlert, breakIt, reset, submitFix, recover, noteModelCall,
    resetAt: () => resetAt,
    stats: () => ({ up: shopUp, current: history.at(-1) ?? null, history: history.slice(-90) }),
  };
}

function renderPrBody(id: string, r: SubmitFixRequest) {
  const pm = r.postmortem;
  return [
    `Automated fix by **Plumberr** for incident \`${id}\`.`,
    "",
    `**Root cause** (${r.rootCause.category}, ${Math.round(r.rootCause.confidence * 100)}% confidence${r.rootCause.culpritSha ? `, culprit ${r.rootCause.culpritSha.slice(0, 7)}` : ""}): ${r.rootCause.summary}`,
    "",
    "**Evidence**",
    ...r.rootCause.evidence.map((e) => `- ${e}`),
    "",
    "## Postmortem",
    `**Summary:** ${pm.summary}`,
    `**Impact:** ${pm.impact ?? "see incident timeline"}`,
    "**Timeline:**",
    ...(pm.timeline ?? []).map((t) => `- ${t}`),
    `**Root cause:** ${pm.rootCause ?? r.rootCause.summary}`,
    `**Fix:** ${pm.fix ?? `${r.title} (${r.changes.map((c) => c.path).join(", ")})`}`,
    "**Follow-ups:**",
    ...(pm.followUps ?? []).map((f) => `- [ ] ${f}`),
    "",
    "_Requires human review. Plumberr never merges._",
  ].join("\n");
}
