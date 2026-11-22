"use client";
import { AnimatePresence, motion } from "motion/react";
import { sourceOf, type TimelineEvent } from "@plumberr/shared/schemas";
import { AlertTriangle, Ban, Bell, Bomb, Brain, CheckCircle2, Cpu, Database, GitPullRequest, Info, Package, Wrench, XCircle, Zap } from "lucide-react";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "fault.injected": Bomb,
  "alert.fired": Bell,
  "agent.dispatched": Zap,
  "collector.step": Database,
  "collector.bundle": Package,
  "agent.tool_call": Wrench,
  "agent.model_call": Brain,
  "agent.llm_call": Cpu,
  "agent.blocked": Ban,
  "rca.declared": AlertTriangle,
  "pr.opened": GitPullRequest,
  "agent.end": CheckCircle2,
  resolved: CheckCircle2,
  error: XCircle,
  info: Info,
};
const COLORS: Record<string, string> = {
  "fault.injected": "text-red-400",
  "alert.fired": "text-amber-400",
  "rca.declared": "text-orange-300",
  "pr.opened": "text-emerald-400",
  resolved: "text-emerald-400",
  error: "text-red-400",
};

const SOURCE_STYLE = {
  collector: "border-sky-500/40 text-sky-300",
  agent: "border-violet-500/40 text-violet-300",
  system: "border-border text-muted-foreground",
} as const;

/** llm_call events are rendered in the time-split panel; model_call duplicates them when the proxy is on. */
const HIDDEN = new Set(["info"]);

export function Timeline({ events, startedAt }: { events: TimelineEvent[]; startedAt: string }) {
  const hasProxy = events.some((e) => e.kind === "agent.llm_call");
  events = events.filter((e) => !HIDDEN.has(e.kind) && !(hasProxy && e.kind === "agent.model_call"));
  const t0 = Date.parse(startedAt);
  return (
    <ol className="space-y-2">
      <AnimatePresence initial={false}>
        {events.map((e) => {
          const Icon = ICONS[e.kind] ?? Info;
          const dur = typeof e.data?.durationMs === "number" ? `${e.data.durationMs}ms` : typeof e.data?.ms === "number" ? `${e.data.ms}ms` : null;
          const src = sourceOf(e.kind);
          return (
            <motion.li
              key={e.seq}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-start gap-3 rounded-lg border border-border bg-card/60 p-3"
            >
              <Icon className={`mt-0.5 size-4 shrink-0 ${COLORS[e.kind] ?? "text-sky-300"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">+{((Date.parse(e.ts) - t0) / 1000).toFixed(1)}s</span>
                  <span className={`rounded border px-1.5 py-px text-[10px] uppercase tracking-wide ${SOURCE_STYLE[src]}`}>{src}</span>
                  <span>{e.kind}</span>
                  {dur && <span className="font-mono">· {dur}</span>}
                </div>
                <div className="break-words text-sm">{e.text}</div>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
      {events.length === 0 && <li className="text-sm text-muted-foreground">Waiting for events…</li>}
    </ol>
  );
}
