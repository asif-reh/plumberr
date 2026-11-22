import { Redis } from "ioredis";

/**
 * Global incident lock (one live incident at a time across replicas) + per-IP rate limit.
 * Redis SET NX PX when REDIS_URL is set; in-memory fallback for single-process dev.
 */
export interface Coord {
  kind: "redis" | "memory";
  acquire(owner: string, ttlMs: number): Promise<boolean>;
  release(owner: string): Promise<void>;
  holder(): Promise<string | null>;
  /** Returns remaining allowance (<0 means limited). */
  hit(key: string, limit: number, windowSec: number): Promise<number>;
}
const LOCK = "plumberr:lock:incident";

export function createCoord(redisUrl?: string): Coord {
  if (!redisUrl) {
    let lock: { owner: string; until: number } | null = null;
    const hits = new Map<string, { n: number; until: number }>();
    return {
      kind: "memory",
      async acquire(owner, ttlMs) {
        if (lock && lock.until > Date.now()) return false;
        lock = { owner, until: Date.now() + ttlMs };
        return true;
      },
      async release(owner) { if (lock?.owner === owner) lock = null; },
      async holder() { return lock && lock.until > Date.now() ? lock.owner : null; },
      async hit(key, limit, windowSec) {
        const now = Date.now();
        const h = hits.get(key);
        const cur = h && h.until > now ? h : { n: 0, until: now + windowSec * 1000 };
        cur.n++;
        hits.set(key, cur);
        return limit - cur.n;
      },
    };
  }
  const r = new Redis(redisUrl, { maxRetriesPerRequest: 2, family: 0 });
  return {
    kind: "redis",
    async acquire(owner, ttlMs) { return (await r.set(LOCK, owner, "PX", ttlMs, "NX")) === "OK"; },
    async release(owner) {
      // compare-and-delete so a stale holder can't drop someone else's lock
      await r.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, LOCK, owner);
    },
    async holder() { return r.get(LOCK); },
    async hit(key, limit, windowSec) {
      const k = `plumberr:rl:${key}`;
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, windowSec);
      return limit - n;
    },
  };
}
