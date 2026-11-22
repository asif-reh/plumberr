import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Incident, TimelineEvent, TimelineEventInput } from "@plumberr/shared/schemas";

export interface Store {
  kind: "postgres" | "memory";
  init(): Promise<void>;
  createIncident(i: Incident): Promise<Incident>;
  getIncident(id: string): Promise<Incident | null>;
  listIncidents(limit?: number): Promise<Incident[]>;
  updateIncident(id: string, patch: Partial<Incident>): Promise<Incident | null>;
  activeIncident(): Promise<Incident | null>;
  appendEvent(e: TimelineEventInput): Promise<TimelineEvent>;
  events(incidentId: string, afterSeq?: number): Promise<TimelineEvent[]>;
  byRunId(runId: string): Promise<Incident | null>;
  /** Fastest correctly-graded incident (page → PR) for replay mode. */
  best(): Promise<Incident | null>;
}

const pageToPr = (i: Incident) =>
  i.alertedAt && i.prOpenedAt ? Date.parse(i.prOpenedAt) - Date.parse(i.alertedAt) : Number.POSITIVE_INFINITY;

const ACTIVE = ["injecting", "degraded", "alerted", "investigating", "root_caused", "pr_opened"];

/* ── in-memory (zero-dependency local dev) ── */
export function memoryStore(): Store {
  const incidents = new Map<string, Incident>();
  const evts: TimelineEvent[] = [];
  let seq = 0;
  return {
    kind: "memory",
    async init() {},
    async createIncident(i) { incidents.set(i.id, i); return i; },
    async getIncident(id) { return incidents.get(id) ?? null; },
    async listIncidents(limit = 50) {
      return [...incidents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
    async updateIncident(id, patch) {
      const cur = incidents.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      incidents.set(id, next);
      return next;
    },
    async activeIncident() {
      return [...incidents.values()].find((i) => ACTIVE.includes(i.status)) ?? null;
    },
    async appendEvent(e) {
      const ev: TimelineEvent = { ...e, seq: ++seq, ts: new Date().toISOString() };
      evts.push(ev);
      return ev;
    },
    async events(incidentId, afterSeq = 0) {
      return evts.filter((e) => e.incidentId === incidentId && e.seq > afterSeq);
    },
    async byRunId(runId) { return [...incidents.values()].find((i) => i.runId === runId) ?? null; },
    async best() {
      const done = [...incidents.values()].filter((i) => i.grade?.correct && i.prOpenedAt);
      return done.sort((a, b) => pageToPr(a) - pageToPr(b))[0] ?? null;
    },
  };
}

/* ── Postgres ── */
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
const rowToIncident = (r: Record<string, unknown>): Incident => ({
  id: r.id as string,
  faultId: r.fault_id as string,
  status: r.status as Incident["status"],
  createdAt: iso(r.created_at)!,
  alertedAt: iso(r.alerted_at),
  rootCausedAt: iso(r.root_caused_at),
  prOpenedAt: iso(r.pr_opened_at),
  resolvedAt: iso(r.resolved_at),
  rca: (r.rca as Incident["rca"]) ?? null,
  prUrl: (r.pr_url as string) ?? null,
  grade: (r.grade as Incident["grade"]) ?? null,
  runId: (r.run_id as string) ?? null,
});
const rowToEvent = (r: Record<string, unknown>): TimelineEvent => ({
  seq: Number(r.seq),
  incidentId: r.incident_id as string,
  kind: r.kind as TimelineEvent["kind"],
  text: r.text as string,
  data: (r.data as Record<string, unknown>) ?? undefined,
  ts: iso(r.ts)!,
});
const COLS: Record<string, string> = {
  status: "status", alertedAt: "alerted_at", rootCausedAt: "root_caused_at", prOpenedAt: "pr_opened_at",
  resolvedAt: "resolved_at", rca: "rca", prUrl: "pr_url", grade: "grade", runId: "run_id",
};

export function postgresStore(url: string): Store {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: "postgres",
    async init() {
      const here = dirname(fileURLToPath(import.meta.url));
      const dir = join(here, "..", "migrations");
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        await pool.query(readFileSync(join(dir, f), "utf8"));
      }
    },
    async createIncident(i) {
      await pool.query(
        "INSERT INTO incidents (id, fault_id, status, created_at) VALUES ($1,$2,$3,$4)",
        [i.id, i.faultId, i.status, i.createdAt],
      );
      return i;
    },
    async getIncident(id) {
      const { rows } = await pool.query("SELECT * FROM incidents WHERE id=$1", [id]);
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async listIncidents(limit = 50) {
      const { rows } = await pool.query("SELECT * FROM incidents ORDER BY created_at DESC LIMIT $1", [limit]);
      return rows.map(rowToIncident);
    },
    async updateIncident(id, patch) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        const col = COLS[k];
        if (!col) continue;
        vals.push((k === "rca" || k === "grade") && v != null ? JSON.stringify(v) : v);
        sets.push(`${col}=$${vals.length}`);
      }
      if (!sets.length) return this.getIncident(id);
      vals.push(id);
      const { rows } = await pool.query(`UPDATE incidents SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async activeIncident() {
      const { rows } = await pool.query(
        "SELECT * FROM incidents WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 1",
        [ACTIVE],
      );
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async appendEvent(e) {
      const { rows } = await pool.query(
        "INSERT INTO timeline_events (incident_id, kind, text, data) VALUES ($1,$2,$3,$4) RETURNING *",
        [e.incidentId, e.kind, e.text, e.data ? JSON.stringify(e.data) : null],
      );
      return rowToEvent(rows[0]);
    },
    async events(incidentId, afterSeq = 0) {
      const { rows } = await pool.query(
        "SELECT * FROM timeline_events WHERE incident_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT 1000",
        [incidentId, afterSeq],
      );
      return rows.map(rowToEvent);
    },
    async byRunId(runId) {
      const { rows } = await pool.query("SELECT * FROM incidents WHERE run_id=$1 LIMIT 1", [runId]);
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async best() {
      const { rows } = await pool.query(
        `SELECT * FROM incidents WHERE pr_opened_at IS NOT NULL AND alerted_at IS NOT NULL AND (grade->>'correct')::boolean
         ORDER BY pr_opened_at - alerted_at ASC LIMIT 1`,
      );
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
  };
}
