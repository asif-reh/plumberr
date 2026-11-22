"use client";
import type { Incident } from "@plumberr/shared/schemas";
import { fmtDuration } from "@/lib/utils";
import { useNow } from "@/lib/sse";
import { cn } from "@/lib/utils";

const t = (s: string | null) => (s ? Date.parse(s) : null);

export function IncidentTimers({ incident, nowMs }: { incident: Incident; nowMs?: number }) {
  const tick = useNow(100);
  const now = nowMs ?? tick;
  const created = t(incident.createdAt)!;
  const alerted = t(incident.alertedAt);
  const rca = t(incident.rootCausedAt);
  const pr = t(incident.prOpenedAt);
  const done = pr ?? t(incident.resolvedAt);
  const big = alerted ? (done ?? now) - alerted : null;

  const parts = [
    { label: "Detect", ms: (alerted ?? now) - created, live: !alerted },
    { label: "Root cause", ms: alerted ? (rca ?? now) - alerted : null, live: !!alerted && !rca },
    { label: "Fix PR", ms: alerted ? (pr ?? now) - alerted : null, live: !!alerted && !pr },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-6 text-center">
      <div className="text-xs uppercase tracking-widest text-muted-foreground">page → fix PR</div>
      <div className={cn("font-mono text-7xl font-bold tabular-nums md:text-8xl", pr ? "text-emerald-400" : alerted ? "text-red-400" : "text-muted-foreground")}>
        {fmtDuration(big)}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {parts.map((p) => (
          <div key={p.label} className="rounded-lg border border-border p-2">
            <div className="text-xs text-muted-foreground">{p.label}</div>
            <div className={cn("font-mono text-xl tabular-nums", p.live && "animate-pulse")}>{fmtDuration(p.ms)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
