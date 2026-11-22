"use client";
import { useEffect, useRef, useState } from "react";
import type { Incident, TimelineEvent } from "@plumberr/shared/schemas";
import { API_URL } from "./api";

/**
 * Live incident stream. EventSource auto-reconnects and re-sends Last-Event-ID,
 * which the api uses to replay missed events from Postgres.
 */
export function useIncidentStream(id: string, initial?: { incident: Incident; events: TimelineEvent[] }) {
  const [incident, setIncident] = useState<Incident | null>(initial?.incident ?? null);
  const [events, setEvents] = useState<TimelineEvent[]>(initial?.events ?? []);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(initial?.events.at(-1)?.seq ?? 0);

  useEffect(() => {
    const url = `${API_URL}/incidents/${id}/stream${lastSeq.current ? `?lastEventId=${lastSeq.current}` : ""}`;
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("timeline", (msg) => {
      const { event, incident } = JSON.parse((msg as MessageEvent).data) as { event: TimelineEvent; incident: Incident };
      if (event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      setEvents((prev) => [...prev, event]);
      if (incident) setIncident(incident);
    });
    return () => es.close();
  }, [id]);

  return { incident, events, connected };
}

export function usePolling<T>(fn: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = () => fnRef.current().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e: Error) => alive && setError(e.message));
    tick();
    const t = setInterval(tick, ms);
    return () => { alive = false; clearInterval(t); };
  }, [ms]);
  return { data, error };
}

export function useNow(intervalMs = 100) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
