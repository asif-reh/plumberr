import { getConfig } from "./config.js";

/** Files of the simulated target repo, readable by the agent (and the evidence collector). */
const PRICING_TS = `// src/lib/pricing.ts
import { flags } from "../config";

export interface Coupon { percentOff: number }

export function price(totalCents: number, coupon: Coupon | null): number {
  if (flags.newPricing) {
    // new pricing path (dark-launched)
    return Math.round(totalCents * (1 - coupon.percentOff / 100)); // line 9
  }
  return coupon ? Math.round(totalCents * (1 - coupon.percentOff / 100)) : totalCents;
}
`;
const ORDERS_TS = `// src/routes/orders.ts
export async function listOrders(db, userId: number) {
  return db.query(
    "SELECT id, user_id, total_cents, created_at FROM shop_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
    [userId],
  );
}
`;
const INIT_SQL = `-- migrations/0001_init.sql
CREATE TABLE shop_orders (id bigint PRIMARY KEY, user_id int NOT NULL, total_cents int NOT NULL, created_at timestamptz NOT NULL);
CREATE INDEX shop_orders_user_id_idx ON shop_orders(user_id);
`;
const DROP_SQL = `-- index looks unused in pg_stat_user_indexes (stats were reset yesterday)
DROP INDEX IF EXISTS shop_orders_user_id_idx;
`;

export function readRepoFile(path: string): string | null {
  const p = path.replace(/^\.?\//, "");
  switch (p) {
    case "config/prod.json": {
      // ordersIndex is the simulator's switch for the schema state (F2), not a real config key
      const { ordersIndex: _o, ...db } = getConfig().db;
      return JSON.stringify({ ...getConfig(), db }, null, 2) + "\n";
    }
    case "src/lib/pricing.ts":
      return PRICING_TS;
    case "src/routes/orders.ts":
      return ORDERS_TS;
    case "migrations/0001_init.sql":
      return INIT_SQL;
    case "migrations/0007_drop_unused_index.sql":
      return getConfig().db.ordersIndex ? null : DROP_SQL;
    default:
      return null;
  }
}
export const listRepoFiles = () =>
  ["config/prod.json", "src/lib/pricing.ts", "src/routes/orders.ts", "migrations/0001_init.sql", "migrations/0007_drop_unused_index.sql"].filter(
    (p) => readRepoFile(p) != null,
  );
