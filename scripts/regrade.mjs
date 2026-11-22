#!/usr/bin/env node
// Re-run the deterministic grader over stored incidents (after a grader fix). Usage: node scripts/regrade.mjs [incidentId...]
import { createRequire } from "node:module";
const pg = createRequire(new URL("../apps/api/package.json", import.meta.url))("pg"); // reuse the api's pg
import { getFault, gradeFix } from "../packages/shared/dist/faults.js";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://plumberr:plumberr@localhost:5432/plumberr" });
await db.connect();
const ids = process.argv.slice(2);
const { rows } = await db.query(
  `SELECT i.id, i.fault_id, i.rca, (SELECT data FROM timeline_events WHERE incident_id=i.id AND kind='pr.opened' ORDER BY seq LIMIT 1) pr,
          (SELECT data->>'sha' FROM timeline_events WHERE incident_id=i.id AND kind='fault.injected' ORDER BY seq LIMIT 1) sha
     FROM incidents i WHERE i.pr_opened_at IS NOT NULL ${ids.length ? "AND i.id = ANY($1)" : ""}`,
  ids.length ? [ids] : [],
);
for (const r of rows) {
  const fault = getFault(r.fault_id);
  if (!fault || !r.rca || !r.pr?.changes) { console.log(r.id, "skip (no submit_fix data)"); continue; }
  const g = gradeFix(fault, {
    category: r.rca.category,
    text: [r.rca.summary, ...r.rca.evidence, r.pr.title, ...r.pr.changes.map((c) => c.path)].join("\n"),
    culpritSha: r.rca.culpritSha, files: r.pr.changes.map((c) => c.path), contents: r.pr.changes.map((c) => c.content),
  }, r.sha);
  await db.query("UPDATE incidents SET grade=$2 WHERE id=$1", [r.id, JSON.stringify(g)]);
  console.log(r.id, r.fault_id, JSON.stringify(g));
}
await db.end();
