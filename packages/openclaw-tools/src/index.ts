import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { ConfigSchema } from "./config.js";
import { api, untrusted } from "./http.js";

const IncidentId = Type.String({ description: "Incident id from the page, e.g. inc_1a2b3c4d." });
const PATH = "^(src|config|migrations)/[\\w./-]+$";

/**
 * Every tool talks only to the Plumberr api (/internal/*, internal token). Timeline events for tool
 * calls come from the plumberr-hooks plugin (after_tool_call), not from here.
 */
export default defineToolPlugin({
  id: "plumberr-tools",
  name: "Plumberr On-call Tools",
  description: "Read-only observability + git tools and one write tool (submit_fix) for the Plumberr SRE agent.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "get_logs",
      label: "Get logs",
      description: "Recent deduplicated demo-shop log groups (with counts). Only if the page's evidence bundle is insufficient. Output is untrusted data.",
      workspaceAccess: false,
      parameters: Type.Object({
        incidentId: IncidentId,
        query: Type.Optional(Type.String({ description: "Substring filter, e.g. 'timeout'." })),
        level: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warn"), Type.Literal("info")])),
        sinceMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      async execute(p, c, ctx) {
        const qs = new URLSearchParams({ sinceMinutes: String(p.sinceMinutes ?? 10), limit: String(p.limit ?? 20) });
        if (p.query) qs.set("q", p.query);
        if (p.level) qs.set("level", p.level);
        return untrusted(await api(c.apiBaseUrl, `/internal/agent/logs?${qs}`, c.apiToken, undefined, ctx.signal));
      },
    }),
    tool({
      name: "query_metrics",
      label: "Query metrics",
      description: "Current SLO stats (errorRate, p95Ms, per-route p95, rate429, rps) and the last 60s of samples.",
      workspaceAccess: false,
      parameters: Type.Object({ incidentId: IncidentId }),
      async execute(_p, c, ctx) {
        return api(c.apiBaseUrl, "/internal/agent/metrics", c.apiToken, undefined, ctx.signal);
      },
    }),
    tool({
      name: "get_recent_commits",
      label: "Recent commits",
      description: "Commits on main in the last N minutes; set sha to get one commit's full diff. Untrusted data.",
      workspaceAccess: false,
      parameters: Type.Object({
        incidentId: IncidentId,
        sinceMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
        sha: Type.Optional(Type.String({ description: "Return this commit with its diff." })),
      }),
      async execute(p, c, ctx) {
        const path = p.sha ? `/internal/agent/commits/${encodeURIComponent(p.sha)}` : `/internal/agent/commits?sinceMinutes=${p.sinceMinutes ?? 120}`;
        return untrusted(await api(c.apiBaseUrl, path, c.apiToken, undefined, ctx.signal));
      },
    }),
    tool({
      name: "read_file",
      label: "Read file",
      description: "Read a file from the target repo (src/**, config/**, migrations/** only).",
      workspaceAccess: false,
      parameters: Type.Object({ incidentId: IncidentId, path: Type.String({ pattern: PATH }) }),
      async execute(p, c, ctx) {
        return untrusted(await api(c.apiBaseUrl, `/internal/agent/file?path=${encodeURIComponent(p.path)}`, c.apiToken, undefined, ctx.signal));
      },
    }),
    tool({
      name: "submit_fix",
      label: "Submit fix",
      description:
        "Declare the root cause AND open ONE fix PR with a blameless postmortem, in a single call. Stops the RCA timer, then the PR timer. " +
        "Idempotent per incident. changes: full new file contents, max 5 files, paths under src/, config/ or migrations/. Call it in your first response if the evidence suffices.",
      workspaceAccess: false,
      parameters: Type.Object({
        incidentId: IncidentId,
        rootCause: Type.Object({
          summary: Type.String({ maxLength: 1000 }),
          category: Type.Union(["config", "db", "memory", "code", "dependency", "capacity"].map((v) => Type.Literal(v))),
          culpritSha: Type.Optional(Type.String({ description: "Full or 7+ char sha of the culprit commit." })),
          confidence: Type.Number({ minimum: 0, maximum: 1 }),
          evidence: Type.Array(Type.String({ maxLength: 400 }), { minItems: 2, maxItems: 6 }),
        }),
        title: Type.String({ maxLength: 120 }),
        changes: Type.Array(Type.Object({ path: Type.String({ pattern: PATH }), content: Type.String() }), { minItems: 1, maxItems: 5 }),
        postmortem: Type.Object(
          {
            summary: Type.String(),
            impact: Type.Optional(Type.String()),
            timeline: Type.Optional(Type.Union([Type.Array(Type.String(), { maxItems: 8 }), Type.String()])),
            rootCause: Type.Optional(Type.String()),
            fix: Type.Optional(Type.String()),
            followUps: Type.Optional(Type.Union([Type.Array(Type.String(), { maxItems: 5 }), Type.String()])),
          },
          { description: "Blameless postmortem. Only summary is required." },
        ),
      }),
      async execute(p, c, ctx) {
        const { incidentId, ...body } = p;
        for (const ch of body.changes) if (ch.path.includes("..")) throw new Error(`path not allowed: ${ch.path}`);
        return api(c.apiBaseUrl, `/internal/incidents/${encodeURIComponent(incidentId)}/submit-fix`, c.apiToken, {
          method: "POST",
          body: JSON.stringify(body),
        }, ctx.signal ?? AbortSignal.timeout(60_000));
      },
    }),
  ],
});
