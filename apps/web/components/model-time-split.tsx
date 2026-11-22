"use client";
import type { TimelineEvent } from "@plumberr/shared/schemas";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Measured-only split of model time: Cerebras time_info (via cerebras-proxy) when available,
 * otherwise OpenClaw's model_call_ended durations (total only). Nothing is estimated.
 */
export function ModelTimeSplit({ events }: { events: TimelineEvent[] }) {
  const calls = events.filter((e) => e.kind === "agent.llm_call").map((e) => e.data as Record<string, number | string | null | boolean>);
  const turns = events.filter((e) => e.kind === "agent.model_call" && e.data?.outcome === "completed");
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  if (!calls.length && !turns.length) {
    return (
      <Card>
        <CardHeader><CardTitle>Model time</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">No model calls measured yet.</CardContent>
      </Card>
    );
  }
  if (!calls.length) {
    const total = turns.reduce((a, e) => a + num(e.data?.durationMs), 0);
    return (
      <Card>
        <CardHeader><CardTitle>Model time · {turns.length} turns</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <div className="font-mono text-2xl">{s(total)}</div>
          <p className="text-xs text-muted-foreground">Total from OpenClaw model_call_ended. Queue vs generation needs the cerebras-proxy in the path.</p>
        </CardContent>
      </Card>
    );
  }
  const queue = calls.reduce((a, c) => a + num(c.queueMs), 0);
  const gen = calls.reduce((a, c) => a + num(c.generationMs), 0);
  const prompt = calls.reduce((a, c) => a + num(c.promptMs), 0);
  const wall = calls.reduce((a, c) => a + num(c.wallMs), 0);
  const other = Math.max(0, wall - queue - gen - prompt);
  const tokens = calls.reduce((a, c) => a + num(c.completionTokens), 0);
  const seg = [
    { label: "queue (waiting for capacity)", ms: queue, cls: "bg-amber-500/80" },
    { label: "prefill", ms: prompt, cls: "bg-sky-500/80" },
    { label: "generation", ms: gen, cls: "bg-emerald-500/80" },
    { label: "network/other", ms: other, cls: "bg-zinc-500/60" },
  ];
  const source = calls.every((c) => c.timingSource === "cerebras.time_info") ? "Cerebras time_info" : "proxy wall-clock";
  return (
    <Card>
      <CardHeader><CardTitle>Model time · {calls.length} Cerebras calls</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex h-4 w-full overflow-hidden rounded">
          {seg.map((x) => x.ms > 0 && <div key={x.label} className={x.cls} style={{ width: `${(x.ms / wall) * 100}%` }} title={`${x.label} ${s(x.ms)}`} />)}
        </div>
        <div className="grid grid-cols-2 gap-2 font-mono text-xs">
          {seg.map((x) => (
            <div key={x.label} className="flex items-center gap-2">
              <span className={`size-2 rounded-sm ${x.cls}`} /> {x.label}: {s(x.ms)}
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t border-border pt-2 font-mono text-xs">
          <span>total model wall {s(wall)}</span>
          <span>{gen > 0 ? `${Math.round(tokens / (gen / 1000))} tok/s gen` : ""}</span>
        </div>
        <p className="text-xs text-muted-foreground">Measured per call ({source}); not estimated.</p>
      </CardContent>
    </Card>
  );
}
