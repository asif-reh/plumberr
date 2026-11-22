"use client";
import type { Incident, TimelineEvent } from "@plumberr/shared/schemas";
import { CheckCircle2, GitPullRequest, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function FixCard({ incident, events }: { incident: Incident; events: TimelineEvent[] }) {
  const pr = events.find((e) => e.kind === "pr.opened")?.data as
    | { prUrl: string; dryRun: boolean; title: string; changes: Array<{ path: string; content: string }> }
    | undefined;
  return (
    <>
      {incident.rca && (
        <Card>
          <CardHeader><CardTitle>Root cause · {incident.rca.category}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{incident.rca.summary}</p>
            <ul className="list-disc pl-5 text-muted-foreground">{incident.rca.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
            <p className="text-xs text-muted-foreground">
              confidence {(incident.rca.confidence * 100).toFixed(0)}%{incident.rca.culpritSha ? ` · culprit ${incident.rca.culpritSha.slice(0, 7)}` : ""}
            </p>
          </CardContent>
        </Card>
      )}
      {pr && (
        <Card className="border-emerald-500/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-emerald-300">
              <GitPullRequest className="size-4" /> {pr.dryRun ? "Fix PR (dry run)" : "Fix PR opened"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="font-medium">{pr.title}</p>
            {!pr.dryRun && <a className="text-emerald-300 underline" href={pr.prUrl} target="_blank" rel="noreferrer">{pr.prUrl}</a>}
            {pr.changes?.map((c) => (
              <details key={c.path} className="rounded border border-border">
                <summary className="cursor-pointer px-2 py-1 font-mono text-xs">{c.path}</summary>
                <pre className="max-h-64 overflow-auto p-2 text-xs">{c.content}</pre>
              </details>
            ))}
            {incident.grade && (
              <p className="flex items-center gap-1 text-xs">
                {incident.grade.correct ? <CheckCircle2 className="size-3 text-emerald-400" /> : <XCircle className="size-3 text-red-400" />}
                auto-grade: {incident.grade.correct ? "correct" : "incorrect"} (category {incident.grade.categoryMatch ? "✓" : "✗"}, file {incident.grade.fileMatch ? "✓" : "✗"}, keywords {incident.grade.keywordHits.join(", ") || "none"})
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
