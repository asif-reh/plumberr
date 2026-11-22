import { getJSON, type IncidentDetail } from "@/lib/api";
import { LiveIncident } from "./live";

export const dynamic = "force-dynamic";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initial = await getJSON<IncidentDetail>(`/incidents/${id}`).catch(() => undefined);
  return <LiveIncident id={id} initial={initial} />;
}
