"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bomb, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { API_URL, getJSON, type FaultSummary } from "@/lib/api";
import { usePolling } from "@/lib/sse";
import type { Incident } from "@plumberr/shared/schemas";

export function BreakPanel() {
  const router = useRouter();
  const { data: faults } = usePolling(() => getJSON<FaultSummary[]>("/faults"), 60_000);
  const { data: active } = usePolling(() => getJSON<Incident | null>("/incidents/active"), 2000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function breakIt(faultId: string) {
    setBusy(faultId);
    setError(null);
    try {
      const res = await fetch("/api/break", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ faultId }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      router.push(`/incidents/${body.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    await fetch(`${API_URL}/reset`, { method: "POST" }).catch(() => null);
    setBusy(null);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2"><Bomb className="size-4 text-red-400" /> Break it</CardTitle>
          <CardDescription>Push a real fault to the live shop. One live incident at a time (global lock), rate-limited, auto-reset after 10 min.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={reset} disabled={busy !== null}>
          <RotateCcw /> Reset
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {active && (
          <button onClick={() => router.push(`/incidents/${active.id}`)} className="w-full rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-left text-sm">
            🔴 Incident <span className="font-mono">{active.id}</span> in progress ({active.status}) — watch live →
          </button>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {(faults ?? []).filter((f) => f.mvp).map((f) => (
            <div key={f.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{f.title}</span>
                <Badge variant="secondary">{f.category}</Badge>
              </div>
              <p className="font-mono text-xs text-muted-foreground">{f.description}</p>
              <Button variant="destructive" size="sm" disabled={busy !== null || !!active} onClick={() => breakIt(f.id)}>
                {busy === f.id ? <Loader2 className="animate-spin" /> : <Bomb />} Break it
              </Button>
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
