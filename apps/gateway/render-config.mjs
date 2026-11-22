// Merge apps/gateway/openclaw.json5 into an OpenClaw state config (keeps keys OpenClaw wrote, e.g. meta/plugins installs).
//   node render-config.mjs <openclaw.json5> <state/openclaw.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [src, dest] = process.argv.slice(2);
const json5 = readFileSync(src, "utf8")
  .replace(/(^|\s)\/\/.*$/gm, "$1") // strip line comments (a "//" preceded by whitespace; URLs like https:// are untouched)
  .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // quote bare keys
  .replace(/,(\s*[}\]])/g, "$1"); // trailing commas
const patch = JSON.parse(json5);
const base = existsSync(dest) ? JSON.parse(readFileSync(dest, "utf8")) : {};
const merge = (a, b) => {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
};
writeFileSync(dest, JSON.stringify(merge(base, patch), null, 2));
console.log(`rendered ${src} → ${dest}`);
