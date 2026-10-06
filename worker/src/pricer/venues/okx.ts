import type { PricerAsset, Quote, VenueSnapshot } from "../types.js";
import { getJson, parseStrike, parseType, parseYyMmDd, pos } from "./common.js";

export const okxUrl = (asset: PricerAsset) => `https://www.okx.com/api/v5/public/opt-summary?uly=${asset}-USD`;

/** instId e.g. SOL-USD_UM-261007-114-C. IVs are decimals; "0" = no quote. */
export function parseOkx(_asset: PricerAsset, raw: any, fetchedAt: number): Quote[] {
  const out: Quote[] = [];
  for (const r of raw?.data ?? []) {
    const parts = String(r.instId).split("-");
    if (parts.length < 5) continue;
    const type = parseType(parts[parts.length - 1]!);
    const strike = parseStrike(parts[parts.length - 2]!);
    const expiry = parseYyMmDd(parts[parts.length - 3]!);
    const F = pos(r.fwdPx);
    if (!type || !strike || !expiry || !F) continue;
    out.push({
      venue: "okx", instrument: r.instId, type, strike, expiry, forward: F,
      ts: Number(r.ts) || fetchedAt,
      bidIv: pos(r.bidVol), askIv: pos(r.askVol), markIv: pos(r.markVol),
    });
  }
  return out;
}

export async function fetchOkx(asset: PricerAsset): Promise<VenueSnapshot> {
  const raw = await getJson(okxUrl(asset));
  if (raw?.code !== "0") throw new Error(`okx code ${raw?.code}`);
  const fetchedAt = Date.now();
  return { venue: "okx", fetchedAt, quotes: parseOkx(asset, raw, fetchedAt) };
}
