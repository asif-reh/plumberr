"use client";
import { useState } from "react";
import { BreakPanel } from "@/components/break-panel";
import { MetricsPanel } from "@/components/metrics-panel";
import { Replay } from "@/components/replay";
import { Button } from "@/components/ui/button";

export default function Home() {
  const [mode, setMode] = useState<"replay" | "live">("replay");
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Plumberr fixes production leaks <span className="text-primary">in seconds.</span>
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          An autonomous on-call SRE. A deterministic collector bundles the evidence in milliseconds; an OpenClaw agent running Kimi K3.1 Pro on Cerebras
          names the root cause and opens a fix PR with a postmortem in one tool call.
        </p>
        <div className="flex gap-2">
          <Button variant={mode === "replay" ? "default" : "outline"} onClick={() => setMode("replay")}>Replay best run</Button>
          <Button variant={mode === "live" ? "destructive" : "outline"} onClick={() => setMode("live")}>Go live: break it</Button>
        </div>
      </section>
      {mode === "replay" ? (
        <Replay />
      ) : (
        <>
          <MetricsPanel />
          <BreakPanel onReplay={() => setMode("replay")} />
        </>
      )}
    </div>
  );
}
