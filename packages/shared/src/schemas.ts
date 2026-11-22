import { z } from "zod";

export const IncidentStatus = z.enum([
  "injecting",
  "degraded",
  "alerted",
  "investigating",
  "root_caused",
  "pr_opened",
  "resolved",
  "failed",
]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const RcaCategory = z.enum(["config", "db", "memory", "code", "dependency", "capacity"]);
export type RcaCategory = z.infer<typeof RcaCategory>;

export const Incident = z.object({
  id: z.string(),
  faultId: z.string(),
  status: IncidentStatus,
  createdAt: z.string(),
  alertedAt: z.string().nullable(),
  rootCausedAt: z.string().nullable(),
  prOpenedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  rca: z
    .object({
      summary: z.string(),
      category: RcaCategory,
      confidence: z.number(),
      evidence: z.array(z.string()),
      culpritSha: z.string().optional(),
    })
    .nullable(),
  prUrl: z.string().nullable(),
  grade: z
    .object({ correct: z.boolean(), categoryMatch: z.boolean(), keywordHits: z.array(z.string()), fileMatch: z.boolean() })
    .nullable()
    .optional(),
  runId: z.string().nullable().optional(),
});
export type Incident = z.infer<typeof Incident>;

export const TimelineKind = z.enum([
  "fault.injected",
  "alert.fired",
  "collector.step", // deterministic evidence collection (no model)
  "collector.bundle",
  "agent.dispatched",
  "agent.model_call", // OpenClaw model_call_ended hook (TTFB/duration)
  "agent.llm_call", // cerebras-proxy measurement (queue vs generation, reasoning replay)
  "agent.tool_call", // OpenClaw after_tool_call hook
  "agent.blocked", // before_tool_call budget guard
  "rca.declared",
  "pr.opened",
  "agent.end",
  "resolved",
  "error",
  "info",
]);
export type EventSource = "system" | "collector" | "agent";
export const sourceOf = (kind: string): EventSource =>
  kind.startsWith("collector.") ? "collector" : kind.startsWith("agent.") || kind === "rca.declared" || kind === "pr.opened" ? "agent" : "system";
export type TimelineKind = z.infer<typeof TimelineKind>;

export const TimelineEventInput = z.object({
  incidentId: z.string(),
  kind: TimelineKind,
  text: z.string().max(2000),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TimelineEventInput = z.infer<typeof TimelineEventInput>;

export const TimelineEvent = TimelineEventInput.extend({
  seq: z.number().int(),
  ts: z.string(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const AlertPayload = z.object({
  incidentId: z.string().optional(),
  alertName: z.string(),
  service: z.string().default("demo-shop"),
  metric: z.string(),
  value: z.number(),
  threshold: z.number(),
  startedAt: z.string(),
});
export type AlertPayload = z.infer<typeof AlertPayload>;

export const BreakRequest = z.object({ faultId: z.string() });

export const RcaRequest = z.object({
  summary: z.string().min(1).max(1000),
  category: RcaCategory,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).max(10),
  culpritSha: z.string().optional(),
});

/** Models sometimes send a list field as one newline/semicolon-separated string; accept both. */
const strList = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.split(/\n|;\s+/).map((x) => x.replace(/^\s*[-*\d.]+\s*/, "").trim()).filter(Boolean) : v),
    z.array(z.string()).max(max),
  );
/** submit_fix may only touch these trees (no workflows, no dotfiles, no traversal). */
export const FIX_PATH_RE = /^(src|config|migrations)\/(?!.*\.\.)[\w./-]+$/;
export const FileChange = z.object({
  path: z.string().regex(FIX_PATH_RE, "path must be under src/, config/ or migrations/"),
  content: z.string().max(64_000),
});
export const SubmitFixRequest = z.object({
  rootCause: RcaRequest.extend({ evidence: z.array(z.string()).min(2).max(10) }),
  title: z.string().min(1).max(120),
  changes: z.array(FileChange).min(1).max(5),
  /** Only summary is required; the rest is derived server-side if omitted (saves a retry turn). */
  postmortem: z.object({
    summary: z.string(),
    impact: z.string().optional(),
    timeline: strList(12).optional(),
    rootCause: z.string().optional(),
    fix: z.string().optional(),
    followUps: strList(5).optional(),
  }),
});
export type SubmitFixRequest = z.infer<typeof SubmitFixRequest>;

/** Posted by the plumberr-hooks OpenClaw plugin. */
export const AgentHookEvent = z.object({
  type: z.enum(["model_call", "tool_call", "blocked"]),
  runId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

/** Posted by services/cerebras-proxy for every completion request. */
export const LlmCallRecord = z.object({
  model: z.string(),
  status: z.number(),
  stream: z.boolean(),
  wallMs: z.number(),
  ttfbMs: z.number().nullable(),
  firstTokenMs: z.number().nullable(),
  queueMs: z.number().nullable(),
  promptMs: z.number().nullable(),
  generationMs: z.number().nullable(),
  timingSource: z.enum(["cerebras.time_info", "proxy.wallclock"]),
  completionTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  promptTokens: z.number().nullable(),
  reasoningEffort: z.string().nullable(),
  effortInjected: z.boolean(),
  replay: z.object({ assistantToolTurns: z.number(), withReasoning: z.number() }),
  toolCallsOut: z.number(),
});
export type LlmCallRecord = z.infer<typeof LlmCallRecord>;

export const PrOpenedRequest = z.object({ prUrl: z.string().url(), number: z.number().int().optional() });

/** Rolling stats exposed by demo-shop at GET /internal/stats */
export const ShopStats = z.object({
  windowSec: z.number(),
  rps: z.number(),
  errorRate: z.number(),
  rate429: z.number(),
  p95Ms: z.number(),
  routeP95: z.record(z.string(), z.number()).optional(),
  rssMb: z.number(),
  activeFaults: z.array(z.string()),
  ts: z.string(),
});
export type ShopStats = z.infer<typeof ShopStats>;

export const channelFor = (incidentId: string) => `incident:${incidentId}`;
export const CHANNEL_ALL = "incidents:all";
