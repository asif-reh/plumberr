import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Public "Break it" entrypoint. Abuse protection lives here (edge of the system):
 *  - Cloudflare Turnstile (when TURNSTILE_SECRET_KEY is set)
 *  - TODO: Upstash Ratelimit 3 req/IP/hour (UPSTASH_REDIS_REST_URL/TOKEN) — add @upstash/ratelimit
 * The api additionally enforces BREAK_ENABLED and one active incident at a time.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { faultId?: string; turnstileToken?: string };
  if (!body.faultId) return NextResponse.json({ error: "faultId required" }, { status: 400 });

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (secret) {
    const form = new URLSearchParams({ secret, response: body.turnstileToken ?? "" });
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (ip) form.set("remoteip", ip);
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const result = (await v.json()) as { success: boolean };
    if (!result.success) return NextResponse.json({ error: "captcha failed" }, { status: 403 });
  }

  const res = await fetch(`${API_URL}/break`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ faultId: body.faultId }),
  });
  return NextResponse.json(await res.json(), { status: res.status });
}
