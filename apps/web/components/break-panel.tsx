"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bomb, Loader2, PlayCircle, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getJSON, type FaultSummary } from "@/lib/api";
import { usePolling } from "@/lib/sse";
import type { Incident } from "@plumberr/shared/schemas";

interface LockStatus { locked: boolean; incident: Incident | null; resetAt: number | null; now: number; breakEnabled: boolean }

const STATUS_COPY: Record<string, string> = {
  injecting: "pushing the bad deploy…",
  degraded: "production is degrading…",
  alerted: "alert fired, collecting evidence…",
  investigating: "Plumberr is investigating…",
  root_caused: "root cause found, writing the fix…",
  pr_opened: "fixed — fix PR opened ✅",
  failed: "the model is busy right now — watch the replay",
};

export function BreakPanel({ onReplay }: { onReplay?: () => void }) {
  const router = useRouter();
  const { data: faults } = usePolling(() => getJSON<FaultSummary[]>("/faults"), 60_000);
  const { data: lock } = usePolling(() => getJSON<LockStatus>("/lock"), 2000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; replay?: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Server clock skew-safe countdown
  const skew = lock ? lock.now - Date.now() : 0;
  const secsLeft = lock?.resetAt ? Math.max(0, Math.ceil((lock.resetAt - (now + skew)) / 1000)) : null;
  const active = lock?.incident ?? null;
  const locked = !!lock?.locked;
  const disabledLabel = !lock?.breakEnabled
    ? "Live mode paused"
    : locked
      ? secsLeft !== null
        ? `Available in ${secsLeft}s`
        : "Available right after the fix"
      : null;

  async function breakIt(faultId: string) {
    setBusy(faultId);
    setNotice(null);
    try {
      const res = await fetch("/api/break", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ faultId }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.id) return router.push(`/incidents/${body.id}`);
      if (res.status === 429) {
        setNotice({ text: body.error ?? "You've used your live breaks for this hour — here's the best run instead.", replay: true });
        setTimeout(() => onReplay?.(), 2500);
      } else if (res.status === 409) {
        setNotice({ text: "Someone beat you to it — watch their incident live, then try again in a moment." });
      } else if (res.status === 503) {
        setNotice({ text: body.error ?? "Live mode is paused — watch the replay.", replay: true });
      } else {
        setNotice({ text: body.error ?? `Something went wrong (HTTP ${res.status}). Try the replay.`, replay: true });
      }
    } catch {
      setNotice({ text: "Couldn't reach the live shop — here's the replay instead.", replay: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bomb className="size-4 text-red-400" /> Break it</CardTitle>
        <CardDescription>Push a real fault to the live shop and watch Plumberr fix it. One live incident at a time; the shop auto-heals ~30s after the fix.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {locked && active && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">
                <Radio className="mr-1 inline size-4 animate-pulse text-red-400" />
                Someone just broke production. Watch Plumberr fix it live →
              </p>
              <p className="text-muted-foreground">
                <span className="font-mono">{active.id}</span> · fault {active.faultId} · {STATUS_COPY[active.status] ?? active.status}
                {secsLeft !== null && ` · Break-it frees up in ${secsLeft}s`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => router.push(`/incidents/${active.id}`)}>Watch live</Button>
              {onReplay && <Button size="sm" variant="outline" onClick={onReplay}><PlayCircle /> Replay best run</Button>}
            </div>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {(faults ?? []).filter((f) => f.mvp).map((f) => (
            <div key={f.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{f.title}</span>
                <Badge variant="secondary">{f.category}</Badge>
              </div>
              <p className="font-mono text-xs text-muted-foreground">{f.description}</p>
              <Button variant={disabledLabel ? "outline" : "destructive"} size="sm" disabled={busy !== null || !!disabledLabel || !lock} onClick={() => breakIt(f.id)}>
                {busy === f.id ? <Loader2 className="animate-spin" /> : <Bomb />} {disabledLabel ?? "Break it"}
              </Button>
            </div>
          ))}
        </div>
        {notice && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <span>{notice.text}</span>
            {notice.replay && onReplay && <Button size="sm" variant="outline" onClick={onReplay}><PlayCircle /> Replay best run</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
