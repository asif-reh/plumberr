import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

interface Cfg { apiBaseUrl: string; apiToken: string; agentId?: string; maxModelTurns?: number }
interface RunState { completedTurns: number; fixSubmitted: boolean; incidentId?: string; touched: number }

/** Keep only what the timeline needs; never forward file contents or postmortem bodies. */
function summarizeParams(tool: string, p: Record<string, unknown>) {
  if (tool === "submit_fix") {
    const rc = (p.rootCause ?? {}) as Record<string, unknown>;
    return {
      incidentId: p.incidentId, title: p.title, category: rc.category, confidence: rc.confidence, culpritSha: rc.culpritSha,
      files: Array.isArray(p.changes) ? (p.changes as Array<{ path?: string }>).map((c) => c.path) : [],
    };
  }
  const { incidentId, query, level, sinceMinutes, sha, path } = p;
  return { incidentId, query, level, sinceMinutes, sha, path };
}

const META = new Set(["dispatch_action", "tool_search", "tool_describe"]);
/** With Tool Search on, real tools arrive wrapped in dispatch_action; budget on the inner name. */
const innerName = (tool: string, p: Record<string, unknown>) =>
  tool === "dispatch_action" ? String(p.name ?? p.tool ?? p.action ?? p.toolName ?? tool) : tool;

export default definePluginEntry({
  id: "plumberr-hooks",
  name: "Plumberr Hooks",
  description: "Streams agent steps to the Plumberr timeline and enforces a hard model-turn budget.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as unknown as Cfg;
    const maxTurns = cfg.maxModelTurns ?? 3;
    const agentId = cfg.agentId ?? "oncall";
    const runs = new Map<string, RunState>();
    const state = (runId: string) => {
      let s = runs.get(runId);
      if (!s) {
        s = { completedTurns: 0, fixSubmitted: false, touched: Date.now() };
        runs.set(runId, s);
        if (runs.size > 200) runs.delete(runs.keys().next().value!);
      }
      s.touched = Date.now();
      return s;
    };
    const ours = (ctxAgent?: string, sessionKey?: string) =>
      (ctxAgent ? ctxAgent === agentId : true) && !(sessionKey ?? "").endsWith(":main"); // ignore the main session
    const post = (type: "model_call" | "tool_call" | "blocked", runId: string | undefined, data: Record<string, unknown>) => {
      if (!cfg.apiBaseUrl) return;
      void fetch(`${cfg.apiBaseUrl.replace(/\/$/, "")}/internal/agent-events`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ type, runId, data }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    };

    api.on("model_call_ended", (ev, ctx) => {
      if (!ours(ctx.agentId, ev.sessionKey)) return;
      const s = state(ev.runId);
      if (ev.outcome === "completed") s.completedTurns++;
      post("model_call", ev.runId, {
        turn: s.completedTurns, outcome: ev.outcome, errorCategory: ev.errorCategory, failureKind: ev.failureKind,
        durationMs: ev.durationMs, timeToFirstByteMs: ev.timeToFirstByteMs, model: ev.model, incidentId: s.incidentId,
      });
    });

    // Hard budget: turn 1 may read or submit; from turn (max-1) only submit_fix; after a successful submit_fix nothing.
    api.on("before_tool_call", (ev, ctx) => {
      if (!ours(ctx.agentId, ctx.sessionKey)) return;
      const runId = ev.runId ?? ctx.runId;
      if (!runId) return;
      const s = state(runId);
      if (typeof ev.params.incidentId === "string") s.incidentId = ev.params.incidentId;
      const name = innerName(ev.toolName, ev.params);
      if (name === "tool_search" || name === "tool_describe") return; // cheap, no side effects
      let reason: string | null = null;
      if (s.fixSubmitted) reason = "submit_fix already succeeded for this incident. Do not call more tools; reply with one short line and stop.";
      else if (name !== "submit_fix" && s.completedTurns >= maxTurns - 1)
        reason = `Model-turn budget (${maxTurns}) reached: no more investigation. Call submit_fix now with your best root cause and fix.`;
      if (!reason) return;
      post("blocked", runId, { toolName: name, reason, turn: s.completedTurns, incidentId: s.incidentId });
      return { block: true, blockReason: reason };
    });

    api.on("after_tool_call", (ev, ctx) => {
      if (!ours(ctx.agentId, ctx.sessionKey)) return;
      const runId = ev.runId ?? ctx.runId;
      const s = runId ? state(runId) : undefined;
      if (META.has(ev.toolName)) return; // the inner tool reports itself
      if (ev.toolName === "submit_fix" && !ev.error && s) s.fixSubmitted = true;
      post("tool_call", runId, {
        toolName: ev.toolName, params: summarizeParams(ev.toolName, ev.params), durationMs: ev.durationMs,
        error: ev.error, turn: s?.completedTurns, incidentId: s?.incidentId ?? ev.params.incidentId,
      });
    });
  },
});
