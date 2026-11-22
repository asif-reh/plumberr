import { createSign } from "node:crypto";
import { env } from "./env.js";

export interface PrInput { incidentId: string; title: string; body: string; changes: Array<{ path: string; content: string }> }
export interface PrResult { url: string; dryRun: boolean; branch: string; number?: number }

const configured = () => Boolean(env.gh.appId && env.gh.installationId && env.gh.privateKey && env.gh.repo);
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.gh.appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(env.gh.privateKey!);
  return `${head}.${body}.${b64url(sig)}`;
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "plumberr" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/**
 * Opens a PR via the GitHub App (the only place GitHub creds live). Without creds, returns a dry-run
 * result; the full PR content is still recorded on the timeline and shown in the UI.
 * NOTE: the live path is implemented against the REST API but has not been exercised (no App creds on the box).
 */
export async function openPr(p: PrInput): Promise<PrResult> {
  const branch = `plumberr/${p.incidentId}`;
  if (!configured()) return { url: `dry-run://${branch}`, dryRun: true, branch };
  const repo = env.gh.repo!;
  const { token } = await gh<{ token: string }>(appJwt(), "POST", `/app/installations/${env.gh.installationId}/access_tokens`);
  const meta = await gh<{ default_branch: string }>(token, "GET", `/repos/${repo}`);
  const ref = await gh<{ object: { sha: string } }>(token, "GET", `/repos/${repo}/git/ref/heads/${meta.default_branch}`);
  await gh(token, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: ref.object.sha }).catch((e: Error) => {
    if (!/422/.test(e.message)) throw e; // branch exists → reuse (idempotent)
  });
  for (const c of p.changes) {
    const existing = await gh<{ sha: string }>(token, "GET", `/repos/${repo}/contents/${c.path}?ref=${branch}`).catch(() => null);
    await gh(token, "PUT", `/repos/${repo}/contents/${c.path}`, {
      message: `fix(${p.incidentId}): ${c.path}`,
      content: Buffer.from(c.content).toString("base64"),
      branch,
      sha: existing?.sha,
    });
  }
  const pr = await gh<{ html_url: string; number: number }>(token, "POST", `/repos/${repo}/pulls`, {
    title: p.title, head: branch, base: meta.default_branch, body: p.body,
  });
  return { url: pr.html_url, dryRun: false, branch, number: pr.number };
}
