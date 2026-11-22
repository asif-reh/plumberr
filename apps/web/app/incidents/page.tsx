import Link from "next/link";
import type { Incident } from "@plumberr/shared/schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getJSON } from "@/lib/api";
import { fmtDuration } from "@/lib/utils";

export const dynamic = "force-dynamic";

const diff = (a: string | null, b: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);

export default async function IncidentsPage() {
  const incidents = await getJSON<Incident[]>("/incidents").catch(() => [] as Incident[]);
  return (
    <Card>
      <CardHeader><CardTitle>Incident archive</CardTitle></CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-2">Incident</th><th>Fault</th><th>Status</th><th>Detect</th><th>Root cause</th><th>Fix PR</th></tr>
          </thead>
          <tbody>
            {incidents.map((i) => (
              <tr key={i.id} className="border-t border-border">
                <td className="py-2 font-mono"><Link className="hover:underline" href={`/incidents/${i.id}`}>{i.id}</Link></td>
                <td>{i.faultId}</td>
                <td><Badge variant={i.prUrl ? "success" : "secondary"}>{i.status}</Badge></td>
                <td className="font-mono">{fmtDuration(diff(i.createdAt, i.alertedAt))}</td>
                <td className="font-mono">{fmtDuration(diff(i.alertedAt, i.rootCausedAt))}</td>
                <td className="font-mono">{fmtDuration(diff(i.alertedAt, i.prOpenedAt))}</td>
              </tr>
            ))}
            {incidents.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No incidents yet. Go break something.</td></tr>}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
