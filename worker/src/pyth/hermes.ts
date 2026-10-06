// Pyth Hermes REST (off-chain spot for pricing; settlement uses on-chain samples only).
import { cfg } from "../config.js";

export const FEED_IDS = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
} as const;

export interface PythPrice { price: number; conf: number; publishTime: number; expo: number; raw: { price: string; conf: string } }

export function parsePythParsed(p: any): PythPrice {
  const expo = Number(p.price.expo);
  return {
    price: Number(p.price.price) * 10 ** expo,
    conf: Number(p.price.conf) * 10 ** expo,
    publishTime: Number(p.price.publish_time),
    expo,
    raw: { price: String(p.price.price), conf: String(p.price.conf) },
  };
}

function headers(): Record<string, string> {
  if (!cfg.pythHermesApiKey) throw new Error("PYTH_HERMES_API_KEY EMPTY (Hermes returns 401 without it)");
  return { authorization: `Bearer ${cfg.pythHermesApiKey}`, accept: "application/json" };
}

async function hermesGet(base: string, pathAndQuery: string): Promise<any> {
  const res = await fetch(base + pathAndQuery, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`hermes HTTP ${res.status} ${pathAndQuery.split("?")[0]}`);
  return res.json();
}

/** Latest parsed price for one feed. */
export async function getLatestPrice(feedId: string, base = cfg.hermesUrl): Promise<PythPrice> {
  const j = await hermesGet(base, `/v2/updates/price/latest?ids[]=${feedId}&parsed=true`);
  const p = j?.parsed?.[0];
  if (!p) throw new Error("hermes: no parsed price");
  return parsePythParsed(p);
}

/** Price update (binary VAA + parsed) at a historical publish time (bucket start). Used for samples. */
export async function getPriceUpdateAt(feedId: string, publishTime: number, base = cfg.hermesUrl): Promise<{ binary: string[]; parsed: PythPrice }> {
  const j = await hermesGet(base, `/v2/updates/price/${publishTime}?ids[]=${feedId}&parsed=true&encoding=base64`);
  const p = j?.parsed?.[0];
  if (!p || !j?.binary?.data) throw new Error("hermes: no update at publish time");
  return { binary: j.binary.data, parsed: parsePythParsed(p) };
}

/** Parsed price at a past publish time (for spot_moves). */
export async function getHistoricalPrice(feedId: string, publishTime: number, base = cfg.hermesUrl): Promise<PythPrice> {
  const j = await hermesGet(base, `/v2/updates/price/${publishTime}?ids[]=${feedId}&parsed=true`);
  const p = j?.parsed?.[0];
  if (!p) throw new Error("hermes: no price at publish time");
  return parsePythParsed(p);
}
