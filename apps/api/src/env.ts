const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const env = {
  port: num(process.env.API_PORT ?? process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL || undefined,
  redisUrl: process.env.REDIS_URL || undefined,
  shopUrl: process.env.SHOP_URL ?? "http://localhost:4100",
  internalToken: process.env.PLUMBERR_INTERNAL_TOKEN ?? "dev-internal-token-change-me",
  alertSecret: process.env.ALERT_HMAC_SECRET ?? "dev-alert-secret-change-me",
  breakEnabled: (process.env.BREAK_ENABLED ?? "true") !== "false",
  /** Live Break-it per-IP limit: N breaks per window. */
  breakRateLimit: num(process.env.BREAK_RATE_LIMIT, 3),
  breakRateWindowSec: num(process.env.BREAK_RATE_WINDOW_SEC, 3600),
  ownerToken: process.env.OWNER_ADMIN_TOKEN ?? "dev-owner-token-change-me",
  webOrigin: (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim()),
  /** In-process runner (formerly apps/worker). */
  detectorIntervalMs: num(process.env.DETECTOR_INTERVAL_MS, 3000),
  autoResetMs: num(process.env.AUTO_RESET_MS, 10 * 60_000),
  /** Auto-heal: revert the fault + release the lock this long after pr_opened / failed. */
  autoResetAfterPrMs: num(process.env.AUTO_RESET_AFTER_PR_MS, 30_000),
  /** Watchdog: an incident still investigating after this long is failed (+ auto-heal). */
  investigateTimeoutMs: num(process.env.INVESTIGATE_TIMEOUT_MS, 150_000),
  /** Cerebras quota guard: this many failed model calls before a fix → fail gracefully. */
  maxModelErrors: num(process.env.MAX_MODEL_ERRORS, 8),
  loadgenRps: num(process.env.LOADGEN_RPS, 20),
  evidenceMaxBytes: num(process.env.EVIDENCE_MAX_BYTES, 8192),
  openclawUrl: process.env.OPENCLAW_URL || undefined,
  openclawHookToken: process.env.OPENCLAW_HOOK_TOKEN ?? "",
  openclawAgentId: process.env.OPENCLAW_AGENT_ID ?? "oncall",
  openclawTimeoutSeconds: num(process.env.OPENCLAW_TIMEOUT_SECONDS, 1500),
  modelId: process.env.CEREBRAS_MODEL_ID ?? "moonshotai-kimi-k3.1-pro-trial",
  /** GitHub App — only the api holds these. Without them PRs are dry-run previews. */
  gh: {
    appId: process.env.GH_APP_ID || undefined,
    installationId: process.env.GH_INSTALLATION_ID || undefined,
    privateKey: (process.env.GH_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n") || undefined,
    repo: process.env.GH_TARGET_REPO && !process.env.GH_TARGET_REPO.startsWith("your-") ? process.env.GH_TARGET_REPO : undefined,
  },
};
