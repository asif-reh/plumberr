"use client";
import { useEffect, useMemo, useState } from "react";
import type { Incident, TimelineEvent } from "@plumberr/shared/schemas";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FixCard } from "@/components/fix-card";
import { IncidentTimers } from "@/components/incident-timers";
import { ModelTimeSplit } from "@/components/model-time-split";
import { Timeline } from "@/components/timeline";
import { getJSON, type IncidentDetail } from "@/lib/api";

const SPEEDS = [1, 4, 16];
/** Recorded real runs bundled with the site, so replay works even when the api is unreachable. */
const SNAPSHOTS = ["F1", "F4", "F2"] as const;
const loadSnapshot = (id: string) => fetch(`/replay/${id}.json`).then((r) => r.json() as Promise<IncidentDetail>);

/**
 * Replay mode (default public view): plays back the best stored real incident from its recorded
 * timeline. Timers show the recorded (real) durations; only playback speed is changed.
 */
export function Replay() {
  const [data, setData] = useState<IncidentDetail | null | undefined>(undefined);
  const [speed, setSpeed] = useState(4);
  const [playing, setPlaying] = useState(true);
  const [clock, setClock] = useState(0); // ms since incident.createdAt (recorded time)

  const [source, setSource] = useState<string>("live api");
  const pick = (d: IncidentDetail | null, src: string) => { setData(d); setSource(src); setClock(0); setPlaying(true); };

  useEffect(() => {
    getJSON<{ incident: Incident | null; events: TimelineEvent[] }>("/incidents/best")
      .then((d) => (d.incident ? pick(d as IncidentDetail, "live api") : loadSnapshot("F1").then((s) => pick(s, "bundled F1"))))
      .catch(() => loadSnapshot("F1").then((s) => pick(s, "bundled F1")).catch(() => setData(null)));
  }, []);

  const t0 = data ? Date.parse(data.incident.createdAt) : 0;
  const end = data ? Math.max(...data.events.map((e) => Date.parse(e.ts) - t0), 0) + 1500 : 0;

  useEffect(() => {
    if (!playing || !data) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      setClock((c) => Math.min(end, c + (now - last) * speed));
      last = now;
    }, 50);
    return () => clearInterval(id);
  }, [playing, speed, data, end]);

  const view = useMemo(() => {
    if (!data) return null;
    const at = t0 + clock;
    const seen = (iso: string | null) => (iso && Date.parse(iso) <= at ? iso : null);
    const events = data.events.filter((e) => Date.parse(e.ts) <= at);
    const inc = data.incident;
    const incident: Incident = {
      ...inc,
      alertedAt: seen(inc.alertedAt),
      rootCausedAt: seen(inc.rootCausedAt),
      prOpenedAt: seen(inc.prOpenedAt),
      resolvedAt: null,
      rca: seen(inc.rootCausedAt) ? inc.rca : null,
      prUrl: seen(inc.prOpenedAt) ? inc.prUrl : null,
      grade: seen(inc.prOpenedAt) ? inc.grade : null,
      status: seen(inc.prOpenedAt) ? "pr_opened" : seen(inc.rootCausedAt) ? "root_caused" : seen(inc.alertedAt) ? "investigating" : "degraded",
    };
    return { incident, events, at };
  }, [data, clock, t0]);

  if (data === undefined) return <p className="text-muted-foreground">Loading replay…</p>;
  if (data === null || !view) return <p className="text-muted-foreground">No graded incident recorded yet. Go live to make one.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">REPLAY of real run {data.incident.id}</Badge>
        <Badge variant="outline">fault {data.incident.faultId}</Badge>
        <Badge variant="outline">{new Date(data.incident.createdAt).toLocaleString()}</Badge>
        <Badge variant="outline">source: {source}</Badge>
        {SNAPSHOTS.map((id) => (
          <Button key={id} size="sm" variant={data.incident.faultId === id ? "default" : "outline"} onClick={() => void loadSnapshot(id).then((d) => pick(d, `bundled ${id}`))}>
            {id}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setPlaying((p) => !p)}>{playing ? <Pause /> : <Play />}</Button>
          <Button size="sm" variant="outline" onClick={() => { setClock(0); setPlaying(true); }}><RotateCcw /></Button>
          {SPEEDS.map((s) => (
            <Button key={s} size="sm" variant={s === speed ? "default" : "outline"} onClick={() => setSpeed(s)}>{s}×</Button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Playback at {speed}× — every timer and duration shown is the real recorded value.</p>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <IncidentTimers incident={view.incident} nowMs={view.at} />
          <ModelTimeSplit events={view.events} />
          <FixCard incident={view.incident} events={view.events} />
        </div>
        <Card className="lg:col-span-3">
          <CardHeader><CardTitle>Incident timeline</CardTitle></CardHeader>
          <CardContent><Timeline events={view.events} startedAt={data.incident.createdAt} /></CardContent>
        </Card>
      </div>
    </div>
  );
}
