import { env } from "./env.js";

export async function shop<T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetch(`${env.shopUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.internalToken}`, "content-type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(init?.timeoutMs ?? 5000),
  });
  if (!res.ok) throw new Error(`shop ${path} → ${res.status}`);
  return (await res.json()) as T;
}
