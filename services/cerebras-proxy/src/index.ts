import { createServer, type IncomingMessage } from "node:http";

/**
 * Cerebras logging proxy (OpenAI-compatible passthrough).
 * Logs METADATA ONLY — byte lengths, counts, timings, whether reasoning_effort is present, whether
 * assistant tool-call turns carry reasoning. Never message content, never the authorization header.
 */
const PORT = Number(process.env.CEREBRAS_PROXY_PORT ?? 4300);
const UPSTREAM = (process.env.CEREBRAS_UPSTREAM ?? "https://api.cerebras.ai").replace(/\/$/, "");
const FORCE_EFFORT = process.env.FORCE_EFFORT || ""; // e.g. "low": inject reasoning_effort when the client omits it
const API = process.env.PLUMBERR_API_URL ?? "http://127.0.0.1:4000";
const TOKEN = process.env.PLUMBERR_INTERNAL_TOKEN ?? "dev-internal-token-change-me";
/** Hard model-turn budget per agent run (0 = off). Turn = 1 + assistant messages since the last user message. */
const MAX_TURNS = Number(process.env.MAX_MODEL_TURNS ?? 3);
/** After a successful submit_fix, answer the closing turn locally instead of queueing for a one-line reply. */
const SKIP_AFTER_FIX = (process.env.SKIP_TURN_AFTER_FIX ?? "true") !== "false";
const HOP = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"]);

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });

type Msg = { role?: string; content?: unknown; tool_calls?: unknown[]; reasoning?: unknown; reasoning_content?: unknown };
const hasReasoning = (m: Msg) =>
  [m.reasoning, m.reasoning_content].some((r) => typeof r === "string" ? r.length > 0 : r != null) ||
  (Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type?.includes("reason")));

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

createServer(async (req, res) => {
  const t0 = performance.now();
  const url = req.url ?? "/";
  const raw = await readBody(req);
  const isChat = req.method === "POST" && url.endsWith("/chat/completions");
  let body = raw;
  let meta: Record<string, unknown> = {};
  let effort: string | null = null;
  let injected = false;
  let stream = false;
  let replay = { assistantToolTurns: 0, withReasoning: 0 };
  let model = "";
  let turn = 1;
  let fixDone = false;
  if (isChat && raw.length) {
    try {
      const j = JSON.parse(raw.toString("utf8")) as Record<string, unknown> & { messages?: Msg[] };
      model = String(j.model ?? "");
      stream = j.stream === true;
      effort = typeof j.reasoning_effort === "string" ? j.reasoning_effort : null;
      if (!effort && FORCE_EFFORT) {
        j.reasoning_effort = FORCE_EFFORT;
        effort = FORCE_EFFORT;
        injected = true;
        body = Buffer.from(JSON.stringify(j));
      }
      const msgs = j.messages ?? [];
      const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
      turn = 1 + msgs.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
      // Only a boolean is derived from content here (never logged): did the last tool result report a submitted fix?
      const last = msgs.at(-1);
      const lastText = last?.role === "tool" ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "")) : "";
      fixDone = SKIP_AFTER_FIX && /"ok":\s*true/.test(lastText) && /"prUrl"/.test(lastText);
      const tool = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length);
      replay = { assistantToolTurns: tool.length, withReasoning: tool.filter(hasReasoning).length };
      meta = {
        model, stream, messages: msgs.length, requestBytes: body.length,
        roles: msgs.reduce<Record<string, number>>((a, m) => ((a[m.role ?? "?"] = (a[m.role ?? "?"] ?? 0) + 1), a), {}),
        tools: Array.isArray(j.tools) ? j.tools.length : 0, maxTokens: j.max_completion_tokens ?? j.max_tokens ?? null,
        reasoningEffort: effort ?? "absent", effortInjected: injected, replay, turn,
      };
    } catch { meta = { parseError: true, requestBytes: raw.length }; }
  }

  if (isChat && ((MAX_TURNS > 0 && turn > MAX_TURNS) || fixDone)) {
    // Synthetic final answer: ends the agent loop without an upstream call (no queue wait, no tokens).
    const text = fixDone ? "Fix submitted; PR recorded." : `Model-turn budget (${MAX_TURNS}) exhausted; stopping.`;
    const id = `budget-${Date.now()}`;
    log({ evt: fixDone ? "closing_turn_skipped" : "budget_stop", ...meta });
    if (!fixDone) void fetch(`${API}/internal/agent-events`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "blocked", data: { toolName: "model", reason: `proxy refused model turn ${turn} (budget ${MAX_TURNS})`, turn } }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    }
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") headers[k] = v;
  headers["accept-encoding"] = "identity";
  let up: Response;
  try {
    up = await fetch(`${UPSTREAM}${url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  } catch (e) {
    log({ evt: "upstream_error", url, err: (e as Error).message });
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "proxy upstream error" }));
    return;
  }
  const ttfb = performance.now() - t0;
  const outHeaders: Record<string, string> = {};
  up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") outHeaders[k] = v; });
  res.writeHead(up.status, outHeaders);

  // passthrough + parse SSE / JSON for timings
  let firstToken: number | null = null;
  let usage: Record<string, unknown> | null = null;
  let timeInfo: Record<string, number> | null = null;
  let toolCallsOut = 0;
  let respBytes = 0;
  let buf = "";
  const scan = (j: Record<string, unknown>) => {
    if (j.usage) usage = j.usage as Record<string, unknown>;
    if (j.time_info) timeInfo = j.time_info as Record<string, number>;
    const ch = (j.choices as Array<{ delta?: Msg; message?: Msg }> | undefined)?.[0];
    const d = ch?.delta ?? ch?.message;
    if (d && firstToken == null && (d.content || d.reasoning || d.reasoning_content || d.tool_calls)) firstToken = performance.now() - t0;
    if (Array.isArray(d?.tool_calls)) for (const tc of d.tool_calls as Array<{ id?: string }>) if (tc.id || ch?.message) toolCallsOut++;
  };
  if (up.body) {
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      respBytes += value.length;
      res.write(value);
      if (!isChat) continue;
      buf += dec.decode(value, { stream: true });
      if (stream) {
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith("data:") && !line.includes("[DONE]")) { try { scan(JSON.parse(line.slice(5))); } catch { /* partial */ } }
        }
      }
    }
    if (isChat && !stream) { try { scan(JSON.parse(buf)); } catch { /* error body */ } }
  }
  res.end();
  if (!isChat) return;

  const wall = performance.now() - t0;
  const ti = timeInfo as Record<string, number> | null;
  const u = usage as Record<string, unknown> | null;
  const details = (u?.completion_tokens_details ?? {}) as Record<string, unknown>;
  const rec = {
    model, status: up.status, stream,
    wallMs: Math.round(wall), ttfbMs: Math.round(ttfb), firstTokenMs: firstToken == null ? null : Math.round(firstToken),
    queueMs: ti?.queue_time != null ? Math.round(ti.queue_time * 1000) : firstToken != null ? Math.round(firstToken) : null,
    promptMs: ti?.prompt_time != null ? Math.round(ti.prompt_time * 1000) : null,
    generationMs: ti?.completion_time != null ? Math.round(ti.completion_time * 1000) : firstToken != null ? Math.round(wall - firstToken) : null,
    timingSource: ti ? ("cerebras.time_info" as const) : ("proxy.wallclock" as const),
    completionTokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : null,
    reasoningTokens: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : null,
    promptTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : null,
    reasoningEffort: effort, effortInjected: injected, replay, toolCallsOut,
  };
  log({ evt: "chat", ...meta, responseBytes: respBytes, ...rec, rateLimited: up.status === 429 });
  if (replay.assistantToolTurns > replay.withReasoning) {
    log({ evt: "warn_reasoning_replay", missing: replay.assistantToolTurns - replay.withReasoning, of: replay.assistantToolTurns });
  }
  if (up.status === 200) {
    void fetch(`${API}/internal/llm-calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(rec),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}).listen(PORT, process.env.CEREBRAS_PROXY_HOST ?? "127.0.0.1", () => log({ evt: "listening", port: PORT, upstream: UPSTREAM, forceEffort: FORCE_EFFORT || null }));
