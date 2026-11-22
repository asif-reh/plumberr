const MAX_TOOL_OUTPUT = 12 * 1024;

export async function api<T>(base: string, path: string, token: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text || "null") as T;
}

/** Truncate first, then wrap; escape any fence tag inside so data can never close the fence. */
export const untrusted = (v: unknown) => {
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length > MAX_TOOL_OUTPUT) s = `${s.slice(0, MAX_TOOL_OUTPUT)}…[truncated]`;
  return `<untrusted>\n${s.replace(/<\/?untrusted>/gi, (m) => m.replace("<", "&lt;"))}\n</untrusted>`;
};
