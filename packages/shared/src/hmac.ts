import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, body: string, signature: string | undefined | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
