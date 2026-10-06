// Binance /eapi/v1/mark has bid/ask IV but no underlying or timestamp; the forward comes from
// /eapi/v1/index (spot index, r = 0 ⇒ forward ≈ index). "No bid" shows as bidIV≈6e-7 / askIV=-1.
import type { PricerAsset, Quote, VenueSnapshot } from "../types.js";
import { getJson, parseStrike, parseType, parseYyMmDd, pos } from "./common.js";

export const binanceMarkUrl = "https://eapi.binance.com/eapi/v1/mark";
export const binanceIndexUrl = (asset: PricerAsset) => `https://eapi.binance.com/eapi/v1/index?underlying=${asset}USDT`;
const MIN_IV = 0.01; // below this Binance is signalling "no quote"

export function parseBinance(asset: PricerAsset, mark: any[], index: any, fetchedAt: number): Quote[] {
  const F = pos(index?.indexPrice);
  if (!F) return [];
  const ts = Number(index?.time) || fetchedAt;
  const out: Quote[] = [];
  for (const r of mark ?? []) {
    const sym = String(r.symbol);
    if (!sym.startsWith(asset + "-")) continue;
    const [, exp, k, t] = sym.split("-");
    const expiry = parseYyMmDd(exp!);
    const strike = parseStrike(k!);
    const type = parseType(t!);
    if (!expiry || !strike || !type) continue;
    out.push({
      venue: "binance", instrument: sym, type, strike, expiry, forward: F, ts,
      bidIv: pos(r.bidIV, MIN_IV), askIv: pos(r.askIV, MIN_IV), markIv: pos(r.markIV, MIN_IV),
    });
  }
  return out;
}

export async function fetchBinance(asset: PricerAsset): Promise<VenueSnapshot> {
  const [mark, index] = await Promise.all([getJson(binanceMarkUrl), getJson(binanceIndexUrl(asset))]);
  const fetchedAt = Date.now();
  return { venue: "binance", fetchedAt, quotes: parseBinance(asset, mark, index, fetchedAt) };
}
