import { BASE_SHOP_CONFIG, type ShopConfig } from "@plumberr/shared/faults";

type Json = Record<string, unknown>;

function deepMerge<T extends Json>(base: T, patch: Json): T {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object"
        ? deepMerge(cur as Json, v as Json)
        : v;
  }
  return out as T;
}

let current: ShopConfig = structuredClone(BASE_SHOP_CONFIG);
const listeners = new Set<(c: ShopConfig) => void>();

export const getConfig = () => current;
export function patchConfig(patch: Json) {
  current = deepMerge(current as unknown as Json, patch) as unknown as ShopConfig;
  listeners.forEach((l) => l(current));
}
export function resetConfig() {
  current = structuredClone(BASE_SHOP_CONFIG);
  listeners.forEach((l) => l(current));
}
export const onConfigChange = (fn: (c: ShopConfig) => void) => listeners.add(fn);
