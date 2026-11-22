import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { CHANNEL_ALL, type TimelineEvent } from "@plumberr/shared/schemas";

/** Fan-out of timeline events to SSE clients. Redis pub/sub when available (multi-replica safe). */
export interface Bus {
  kind: "redis" | "memory";
  publish(e: TimelineEvent): Promise<void>;
  subscribe(fn: (e: TimelineEvent) => void): () => void;
}

export function createBus(redisUrl?: string): Bus {
  const local = new EventEmitter();
  local.setMaxListeners(0);
  if (!redisUrl) {
    return {
      kind: "memory",
      async publish(e) { local.emit("event", e); },
      subscribe(fn) { local.on("event", fn); return () => local.off("event", fn); },
    };
  }
  const pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  sub.subscribe(CHANNEL_ALL).catch((err) => console.error("[bus] subscribe failed", err));
  sub.on("message", (_ch, msg) => {
    try { local.emit("event", JSON.parse(msg)); } catch { /* ignore */ }
  });
  return {
    kind: "redis",
    async publish(e) { await pub.publish(CHANNEL_ALL, JSON.stringify(e)); },
    subscribe(fn) { local.on("event", fn); return () => local.off("event", fn); },
  };
}
