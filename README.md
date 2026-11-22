# Plumberr 🔧

**Plumberr fixes production leaks in seconds.**

The default public view is a **replay** of the best real stored incident. **Go live** pushes a real fault to a live shop API: a bad config push (F1), a dropped index on a 500k-row Postgres table (F2) or a feature flag that crashes on a null coupon (F4). An in-process detector catches the SLO breach in about 5–10 s. A deterministic **collector** then gathers an evidence bundle of 8 KB or less in milliseconds with zero model calls: the alert, metrics vs baseline, the 3 newest commits with diffs, deduped errors and the relevant files. The bundle goes straight into the page sent to an **OpenClaw agent running Kimi K3.1 Pro on Cerebras**. The agent is told to call **one tool, `submit_fix`**, in its first response; that call records the root cause and opens the fix PR with a postmortem. Every step streams to the dashboard, labelled *collector* or *agent*, alongside a measured split of model **queue vs generation** time.

Why this shape: on the shared hackathon endpoint each model call waits in Cerebras' queue for 30–230 s, while generation takes under 4 s at ~300–600 tok/s. Fewer model turns is the only lever that matters, so evidence collection is not left to the model.

Built for the Cerebras × Kimi K3.1 Pro hackathon (#KimiOnCerebras). The original design is in [PLAN.md](./PLAN.md), which still uses the old working name ClawOnCall and predates this design update.

## Architecture

```
apps/web (Next.js) ──/api/break──▶ apps/api (Hono, ONE service)                          services/demo-shop
  replay (default) / live      │  • POST /break → Redis SET NX global lock → fault ─────▶  (Postgres shop_orders 500k rows,
  ◀── SSE /incidents/:id/stream │  • loadgen loop (20 rps) ─────────────────────────────▶   simulated repo + git log)
                               │  • detector (3 s) → collector → evidence bundle ≤8 KB ◀─ /internal/{stats,logs,commits,file}
                               │  • POST /hooks/agent (Idempotency-Key) ──────────────▶ apps/gateway: OpenClaw 2026.11.6
                               │  • auto-reset after 10 min (setTimeout)                    agent "oncall", toolSearch off
                               │  • GitHub App creds live ONLY here (submit_fix → PR)       ├ plumberr-tools (5 tools → api /internal/*)
                               ◀── /internal/* (PLUMBERR_INTERNAL_TOKEN) ───────────────────┤ plumberr-hooks (after_tool_call,
                               ◀── /internal/llm-calls (queue/gen per call) ──┐              │   model_call_ended, before_tool_call budget)
                                                                              │              ▼
                                                  services/cerebras-proxy (:4300) ◀── provider baseUrl ── Cerebras
                                                  metadata-only logs, FORCE_EFFORT, hard turn cap ──▶ api.cerebras.ai
```

| Path | What it is |
|---|---|
| `apps/web` | Next.js 16. **Replay** (default) plays the best graded incident from its recorded timeline, at 1×, 4× or 16× playback with real timers. **Live** shows the Break-it panel (MVP faults only) and metrics. The incident page has timers, a measured model-time split (queue / prefill / generation / other), the RCA card, PR content and auto-grade, and a timeline labelled collector/agent. |
| `apps/api` | One Hono service, which absorbed the old `apps/worker`; BullMQ is gone. It runs the in-process detector, collector, dispatcher, loadgen and auto-reset. A Redis `SET NX PX` lock enforces one live incident at a time, with an in-memory fallback. `/break` is rate-limited per IP with Redis `INCR`+`EXPIRE` and gated by `BREAK_ENABLED`. Internal API: `/internal/agent/{logs,metrics,commits,file}`, `POST /internal/incidents/:id/submit-fix`, `/internal/agent-events` (hooks) and `/internal/llm-calls` (proxy). Public routes: `GET /incidents/best` (replay), SSE with `Last-Event-ID`, and `/webhooks/alert` (HMAC, optional; e.g. Grafana — not in the critical path). |
| `services/demo-shop` | The victim. `/orders` runs a real Postgres query on `shop_orders` (500k rows seeded with `generate_series`, index on `user_id`). F2 really drops the index and logs slow queries. `/checkout` throws a `TypeError` with a `src/lib/pricing.ts:9` stack frame under F4. It also exposes a per-route p95 and a simulated repo (`config/prod.json`, `src/lib/pricing.ts`, migrations) and git log. |
| `services/cerebras-proxy` | OpenAI-compatible passthrough in front of Cerebras. It logs **metadata only**: byte lengths, message/role/tool counts, `reasoning_effort` present or absent, and whether assistant tool-call turns carry reasoning on replay. It never logs content or the auth header. `FORCE_EFFORT=low` injects `reasoning_effort` only when it is missing. Every call reports `time_info` (queue/prompt/completion), TTFB and first-token timing to the api. It enforces the **hard model-turn cap**: turn > `MAX_MODEL_TURNS` (3) gets a synthetic `stop` completion with no upstream call. |
| `packages/openclaw-tools` | `plumberr-tools`: `get_logs`, `query_metrics`, `get_recent_commits`, `read_file` and **`submit_fix`**. `submit_fix` takes `rootCause{summary,category,culpritSha,confidence,evidence[≥2]}`, `title`, `changes[≤5]` (paths under `src/`, `config/` or `migrations/` only) and `postmortem`. It is idempotent per incident and fires the RCA timer, then the PR timer. Every tool calls only the api. |
| `packages/openclaw-hooks` | `plumberr-hooks` (`definePluginEntry`). `after_tool_call` and `model_call_ended` feed the agent steps of the timeline. `before_tool_call` limits turn 2 and later to `submit_fix` and blocks everything once a fix has been submitted. It uses metadata hooks only, so no conversation-access grant is needed. |
| `packages/shared` | Zod schemas (including `SubmitFixRequest`), the fault catalog (MVP F1/F2/F4, plus F7), the deterministic `gradeFix` grader and HMAC helpers. |
| `apps/gateway` | `openclaw.json5` (Cerebras via proxy, `thinkingDefault: low`, `tools.toolSearch: false`, both plugins), `workspace/AGENTS.md` ("call submit_fix in your first response if evidence suffices"), Dockerfile and entrypoint. |

## Quick start (local)

Requirements: Node ≥ 24.16 and pnpm 10. Docker is optional; you only need it for Postgres and Redis.

```bash
pnpm install
cp .env.example .env            # CEREBRAS_API_KEY can also come from the process env
pnpm db:up                      # Postgres + Redis (or run them natively)
pnpm build
bash scripts/dev-stack.sh       # demo-shop :4100, cerebras-proxy :4300, api :4000 → logs in /tmp/pl
bash scripts/setup-gateway.sh   # once: installs cerebras provider + both plugins, renders config
bash scripts/dev-gateway.sh     # OpenClaw gateway :18789
pnpm --filter @plumberr/web dev # :3000
```

Without `OPENCLAW_URL`, the api runs the agent in dry-run mode: break, detect, collect and SSE all still work. Without `DATABASE_URL`/`REDIS_URL`, the api falls back to in-memory storage, bus and lock, and `/orders` uses simulated latency.

Benchmark the Cerebras queue (slow; run in the background). It makes 10 sequential calls per effort and prints raw `time_info` once, then p50/p95 for queue, completion and wall time plus generation-only tok/s:
```bash
node scripts/bench-queue.mjs --n 10 --efforts low,max > /tmp/pl/bench-queue.log 2>&1 &
```

### Test Cerebras access
```bash
CEREBRAS_API_KEY=... pnpm test:cerebras    # or put the key in .env
```
The script lists the models your key can see, then sends a chat completion to `$CEREBRAS_MODEL_ID` (default `moonshotai-kimi-k3.1-pro-trial`) with `reasoning_effort=low`. It prints usage, timing and tokens/sec.

### Simulate the agent by hand (no Gateway)
```bash
T="Authorization: Bearer $PLUMBERR_INTERNAL_TOKEN"; ID=<incident id>
curl -XPOST localhost:4000/internal/incidents/$ID/submit-fix -H "$T" -H 'content-type: application/json' -d '{
  "rootCause":{"summary":"payments.timeoutMs 2000→50","category":"config","confidence":0.9,"evidence":["504 payments timeout ×53","commit af77208 sets timeoutMs 50"]},
  "title":"fix: restore payments timeout","changes":[{"path":"config/prod.json","content":"{...}"}],
  "postmortem":{"summary":"…","impact":"…","timeline":["…"],"rootCause":"…","fix":"…","followUps":["…"]}}'
```

## Fault catalog (MVP)

| ID | Fault | Real change | Detector SLO | Expected fix |
|---|---|---|---|---|
| F1 | Bad config push | `payments.timeoutMs 2000 → 50` | 5xx > 5% | revert in `config/prod.json` |
| F2 | Dropped index | `migrations/0007_drop_unused_index.sql` really runs `DROP INDEX shop_orders_user_id_idx` on 500k rows | `/orders` p95 > 25 ms (measured: indexed ≈2 ms → seq scan of 106 MB ≈40 ms, page-cached, no parallel workers) | new migration recreating the index |
| F4 | Feature flag | `flags.newPricing → true`; `TypeError` reading `percentOff` of a null coupon (`src/lib/pricing.ts:9`) | 5xx > 5% | null-guard in `src/lib/pricing.ts` |
| F7 | Rate-limit misconfig (extra) | `ratelimit.rpm 6000 → 10` | 429 > 30% | revert in `config/prod.json` |

Each fault records a "chaos-bot" commit with a real unified diff in the shop's simulated git log. `submit_fix` results are auto-graded on category, ≥2 expected keywords, an expected file touched and the culprit SHA. Replay mode shows only correctly graded incidents.

## Deploy

Nothing in this repo has been deployed yet.

### Railway (api, demo-shop, cerebras-proxy, gateway, Postgres, Redis)
1. Create the Railway project `plumberr` and add the **Postgres** and **Redis** plugins.
2. Add five services from this repo and set each one's config file path:
   - `plumberr-api` uses `apps/api/railway.json` (Dockerfile, health check `/health`)
   - `plumberr-proxy` uses `services/cerebras-proxy/railway.json` (set `CEREBRAS_PROXY_HOST=0.0.0.0`; point the gateway's `OPENCLAW_CEREBRAS_BASE_URL` at it, or at `https://api.cerebras.ai/v1` to bypass)
   - `plumberr-shop` uses `services/demo-shop/railway.json`
   - `plumberr-gateway` uses `apps/gateway/railway.json`, with a **volume at `/data`** and `OPENCLAW_GATEWAY_PORT=8080`
3. Set the variables listed in `.env.example`. Use Railway references for `DATABASE_URL` and `REDIS_URL`, and private URLs for the internal ones (for example `SHOP_URL=http://plumberr-shop.railway.internal:4100`, `OPENCLAW_URL=http://plumberr-gateway.railway.internal:8080`, `API_URL`/`PLUMBERR_API_URL=http://plumberr-api.railway.internal:4000`).
4. Give only `plumberr-api` a public domain. Set `WEB_ORIGIN` to the Vercel URL.

### Vercel (web)
1. Import the repo and set **Root Directory** to `apps/web`. `vercel.json` already sets the monorepo install and build commands.
2. Env: `NEXT_PUBLIC_API_URL=https://<plumberr-api domain>`, and optionally `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.

### Custom `.me` domain (later)
Point `plumberr.me` (or whichever name you pick) at Vercel by adding the domain in Vercel and setting the A/CNAME records it gives you. Point `api.plumberr.me` at Railway as a custom domain on `plumberr-api` with a CNAME. Then update `WEB_ORIGIN` and `NEXT_PUBLIC_API_URL`.

## CI
`.github/workflows/ci.yml` runs pnpm install, lint, typecheck and build, then checks the tool plugin metadata is current, validates it, and sanity-checks the hook plugin manifest.

## Status
- ✅ **Real and run locally end to end:** api runner (lock, detector, collector, dispatch, auto-reset, loadgen); OpenClaw gateway with both plugins loaded and hooks registered (`after_tool_call`, `before_tool_call`, `model_call_ended`); cerebras-proxy in the provider path; `submit_fix` with grading; replay mode; F2 on real Postgres.
- 🟡 **Implemented but not exercised:** the GitHub App PR path in `apps/api/src/github.ts` (JWT → installation token → branch → contents → PR). There are no App creds on the dev box, so PRs are dry-run previews; the full content is stored on the timeline and shown in the UI.
- 🟡 **Not wired:** Grafana (intentionally out of the critical path), Upstash, Sentry.
- ⚠️ **Unverified:** the Docker images (no Docker on the dev box; the same steps were verified natively).

## License
MIT
