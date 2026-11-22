"use client";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import type { ShopStats } from "@plumberr/shared/schemas";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getJSON, type StatsResponse } from "@/lib/api";
import { usePolling } from "@/lib/sse";
import { cn } from "@/lib/utils";

const PANELS: Array<{ key: keyof ShopStats; label: string; fmt: (v: number) => string; slo: number; color: string }> = [
  { key: "errorRate", label: "5xx rate", fmt: (v) => `${(v * 100).toFixed(1)}%`, slo: 0.05, color: "#f87171" },
  { key: "p95Ms", label: "p95 latency", fmt: (v) => `${Math.round(v)} ms`, slo: 800, color: "#fbbf24" },
  { key: "rssMb", label: "Memory (RSS)", fmt: (v) => `${Math.round(v)} MB`, slo: 250, color: "#a78bfa" },
  { key: "rate429", label: "429 rate", fmt: (v) => `${(v * 100).toFixed(1)}%`, slo: 0.3, color: "#38bdf8" },
];

export function MetricsPanel() {
  const { data, error } = usePolling(() => getJSON<StatsResponse>("/shop/stats"), 2000);
  const cur = data?.current;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>demo-shop health</CardTitle>
        {error || !data?.up ? (
          <Badge variant="destructive">{error ? "api unreachable" : "shop down"}</Badge>
        ) : (
          <Badge variant="success">{cur?.rps ?? 0} rps</Badge>
        )}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {PANELS.map((p) => {
          const v = Number(cur?.[p.key] ?? 0);
          const breached = v > p.slo;
          return (
            <div key={p.key} className={cn("rounded-lg border p-3", breached ? "border-red-500/60 bg-red-500/5" : "border-border")}>
              <div className="text-xs text-muted-foreground">{p.label}</div>
              <div className={cn("font-mono text-2xl font-semibold", breached && "text-red-400")}>{p.fmt(v)}</div>
              <div className="h-12">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data?.history ?? []}>
                    <YAxis hide domain={[0, "auto"]} />
                    <Area type="monotone" dataKey={p.key} stroke={p.color} fill={p.color} fillOpacity={0.15} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
