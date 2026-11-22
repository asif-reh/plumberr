import pg from "pg";
import { getConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * F2 runs against real Postgres: shop_orders has 500k rows; the /orders query filters by user_id.
 * With shop_orders_user_id_idx it's an index scan (~1ms); after the "0007" migration drops it,
 * every request is a sequential scan (~100ms+ each, worse under load).
 */
const URL = process.env.SHOP_DATABASE_URL || process.env.DATABASE_URL || undefined;
const ROWS = Number(process.env.SHOP_ORDERS_ROWS ?? 500_000);
const SLOW_QUERY_MS = Number(process.env.SHOP_SLOW_QUERY_MS ?? 20);
const INDEX = "shop_orders_user_id_idx";
const SQL = "SELECT id, user_id, total_cents, created_at FROM shop_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20";

let pool: pg.Pool | null = null;
let ready = false;

export const ordersDbReady = () => ready;

export async function initOrdersDb() {
  if (!URL) {
    log.warn("no SHOP_DATABASE_URL/DATABASE_URL — /orders uses simulated latency (F2 simulated)");
    return;
  }
  // Small-instance realism: no parallel seq scans (a 1-vCPU managed Postgres would not have spare workers).
  pool = new pg.Pool({ connectionString: URL, max: 10, options: "-c max_parallel_workers_per_gather=0" });
  const c = await pool.connect();
  try {
    // v2 schema adds a ~160 B note column (order notes / gift message) so rows have a realistic width
    const v2 = await c.query("SELECT 1 FROM information_schema.columns WHERE table_name='shop_orders' AND column_name='note'");
    if (!v2.rowCount) await c.query("DROP TABLE IF EXISTS shop_orders");
    await c.query(`CREATE TABLE IF NOT EXISTS shop_orders (
      id bigint PRIMARY KEY, user_id int NOT NULL, total_cents int NOT NULL, created_at timestamptz NOT NULL, note text)`);
    const { rows } = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM shop_orders");
    if (Number(rows[0]!.n) < ROWS) {
      const t = Date.now();
      await c.query("TRUNCATE shop_orders");
      await c.query(
        `INSERT INTO shop_orders SELECT g, (random()*50000)::int, (random()*20000)::int, now() - (g || ' seconds')::interval,
           repeat(md5(g::text), 5)
         FROM generate_series(1, $1) g`,
        [ROWS],
      );
      await c.query("ANALYZE shop_orders");
      log.info("seeded shop_orders", { rows: ROWS, ms: Date.now() - t });
    }
    await c.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON shop_orders(user_id)`);
    ready = true;
  } finally {
    c.release();
  }
}

/** Apply the config's desired index state (F2 inject = drop, reset = recreate). */
export async function syncIndex() {
  if (!pool) return;
  const want = getConfig().db.ordersIndex;
  const t = Date.now();
  if (want) await pool.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON shop_orders(user_id)`);
  else await pool.query(`DROP INDEX IF EXISTS ${INDEX}`);
  log.info(want ? "migration applied: index ensured" : "migration applied: 0007_drop_unused_index", { index: INDEX, ms: Date.now() - t });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real EXPLAIN (no ANALYZE) of the slow statement, refreshed at most every 15 s. */
let plan: { at: number; text: string } | null = null;
async function explainCached(userId: number) {
  if (!pool || !ready) return undefined;
  if (plan && Date.now() - plan.at < 15_000) return plan.text;
  const r = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${SQL}`, [userId]).catch(() => null);
  plan = { at: Date.now(), text: r ? r.rows.map((x) => x["QUERY PLAN"].trim()).join(" | ") : "explain failed" };
  return plan.text;
}

export async function queryOrders(userId: number) {
  const t = performance.now();
  let rows: unknown[];
  if (pool && ready) {
    rows = (await pool.query(SQL, [userId])).rows;
  } else {
    await sleep(getConfig().db.ordersIndex ? 3 + Math.random() * 5 : 600 + Math.random() * 300);
    rows = [{ id: 1, user_id: userId, total_cents: 4999 }];
  }
  const ms = Math.round(performance.now() - t);
  if (ms >= SLOW_QUERY_MS) {
    log.warn("slow query", { route: "/orders", durationMs: ms, sql: SQL, table: "shop_orders", plan: await explainCached(userId) });
  }
  return rows;
}
