import { getConfig } from "./config.js";
import { cacheEntries, poolWaiting } from "./metrics.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const PRODUCTS = Array.from({ length: 50 }, (_, i) => ({
  id: String(i + 1),
  name: `Claw Gadget #${i + 1}`,
  priceCents: 999 + i * 250,
}));

/* ── cache (F3: memory leak when maxEntries=0 and key includes requestId) ── */
const cache = new Map<string, Buffer>();
export function cachePut(productId: string, requestId: string) {
  const cfg = getConfig().cache;
  const key = cfg.keyIncludesRequestId ? `${productId}:${requestId}` : productId;
  cache.set(key, Buffer.alloc(256 * 1024, 1)); // 256 KB rendered payload
  if (cfg.maxEntries > 0) {
    while (cache.size > cfg.maxEntries) cache.delete(cache.keys().next().value!);
  }
  cacheEntries.set(cache.size);
}
export const clearCache = () => { cache.clear(); cacheEntries.set(0); };

/* ── inventory dependency (F5: slow + no timeout) ── */
export async function fetchInventory(productId: string) {
  const { latencyMs, timeoutMs } = getConfig().inventory;
  const call = sleep(latencyMs + Math.random() * 20).then(() => ({ productId, stock: 42 }));
  if (timeoutMs == null) return call;
  return Promise.race([
    call,
    sleep(timeoutMs).then(() => { throw new HttpError(504, `inventory timeout after ${timeoutMs}ms`); }),
  ]);
}

/* ── DB pool (F6: exhaustion when poolMax is tiny) ── */
let inUse = 0;
const waiters: Array<() => void> = [];
export async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  const acquireTimeout = 2000;
  if (inUse >= getConfig().db.poolMax) {
    poolWaiting.inc();
    try {
      await new Promise<void>((resolve, reject) => {
        const w = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new HttpError(500, "timeout acquiring connection from pool"));
        }, acquireTimeout);
        waiters.push(w);
      });
    } finally { poolWaiting.dec(); }
  }
  inUse++;
  try { return await fn(); } finally {
    inUse--;
    if (inUse < getConfig().db.poolMax) waiters.shift()?.();
  }
}

/* ── payments (F1: timeout shorter than provider latency) ── */
export async function chargePayment(amountCents: number) {
  const { timeoutMs, latencyMs } = getConfig().payments;
  const call = sleep(latencyMs + Math.random() * 30).then(() => ({ ok: true, amountCents }));
  return Promise.race([
    call,
    sleep(timeoutMs).then(() => { throw new HttpError(504, `payments upstream timeout after ${timeoutMs}ms`); }),
  ]);
}

/* ── pricing (F4: dark-launched code path throws on null coupon) ── */
interface Coupon { percentOff: number }
export class PricingError extends TypeError {
  /** Stack frame in the *target repo* (src/lib/pricing.ts) — what a real service would log. */
  readonly frames = ["at price (src/lib/pricing.ts:9:52)", "at checkout (src/routes/checkout.ts:21:24)"];
}
export function price(totalCents: number, coupon: Coupon | null): number {
  if (getConfig().flags.newPricing) {
    // BUG (intentional): new pricing path assumes coupon is always present
    if (coupon == null) throw new PricingError("Cannot read properties of null (reading 'percentOff')");
    return Math.round(totalCents * (1 - coupon.percentOff / 100));
  }
  return coupon ? Math.round(totalCents * (1 - coupon.percentOff / 100)) : totalCents;
}

/* ── rate limiter (F7) ── */
let windowStart = Date.now();
let count = 0;
export function rateLimited(): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
  count++;
  return count > getConfig().ratelimit.rpm;
}
