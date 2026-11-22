CREATE TABLE IF NOT EXISTS incidents (
  id              text PRIMARY KEY,
  fault_id        text NOT NULL,
  status          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  alerted_at      timestamptz,
  root_caused_at  timestamptz,
  pr_opened_at    timestamptz,
  resolved_at     timestamptz,
  rca             jsonb,
  pr_url          text
);
CREATE INDEX IF NOT EXISTS incidents_created_at_idx ON incidents (created_at DESC);

CREATE TABLE IF NOT EXISTS timeline_events (
  seq          bigserial PRIMARY KEY,
  incident_id  text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  text         text NOT NULL,
  data         jsonb,
  ts           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timeline_events_incident_seq_idx ON timeline_events (incident_id, seq);
