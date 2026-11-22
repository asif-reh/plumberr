import type { Incident, ShopStats, TimelineEvent } from "@plumberr/shared/schemas";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface FaultSummary { id: string; title: string; description: string; symptom: string; category: string; mvp: boolean }
export interface StatsResponse { up: boolean; current: ShopStats | null; history: ShopStats[] }
export interface IncidentDetail { incident: Incident; events: TimelineEvent[] }

export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}
