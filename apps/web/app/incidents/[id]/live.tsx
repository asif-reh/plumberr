"use client";
import type { Incident, TimelineEvent } from "@plumberr/shared/schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FixCard } from "@/components/fix-card";
import { ModelTimeSplit } from "@/components/model-time-split";
import { IncidentTimers } from "@/components/incident-timers";
import { MetricsPanel } from "@/components/metrics-panel";
import { Timeline } from "@/components/timeline";
import { useIncidentStream } from "@/lib/sse";

export function LiveIncident({ id, initial }: { id: string; initial?: { incident: Incident; events: TimelineEvent[] } }) {
  const { incident, events, connected } = useIncidentStream(id, initial);
  if (!incident) return <p className="text-muted-foreground">Loading incident…</p>;
  const toolCalls = events.filter((e) => e.kind === "agent.tool_call").length;
  const modelCalls = events.filter((e) => e.kind === "agent.llm_call").length || events.filter((e) => e.kind === "agent.model_call").length;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-semibold">{incident.id}</h1>
        <Badge variant={incident.status === "pr_opened" || incident.status === "resolved" ? "success" : "destructive"}>{incident.status}</Badge>
        <Badge variant="secondary">fault {incident.faultId}</Badge>
        <Badge variant={connected ? "success" : "warning"}>{connected ? "live" : "reconnecting…"}</Badge>
        <Badge variant="outline">{modelCalls} model calls · {toolCalls} tool calls</Badge>
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <IncidentTimers incident={incident} />
          <ModelTimeSplit events={events} />
          <FixCard incident={incident} events={events} />
        </div>
        <Card className="lg:col-span-3">
          <CardHeader><CardTitle>Live incident timeline</CardTitle></CardHeader>
          <CardContent><Timeline events={events} startedAt={incident.createdAt} /></CardContent>
        </Card>
      </div>
      <MetricsPanel />
    </div>
  );
}
