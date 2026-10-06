import type { PricerAsset, Quote, VenueSnapshot } from "../types.js";
import { getJson, parseDdMmmYy, parseStrike, parseType, pos } from "./common.js";

export const bybitUrl = (asset: PricerAsset) => `https://api.bybit.com/v5/market/tickers?category=option&baseCoin=${asset}`;

/** symbol e.g. SOL-8OCT26-121-P-USDT. IVs decimal; "0" = no quote. Response-level `time` is the quote time. */
export function parseBybit(_asset: PricerAsset, raw: any, fetchedAt: number): Quote[] {
  const ts = Number(raw?.time) || fetchedAt;
  const out: Quote[] = [];
  for (const r of raw?.result?.list ?? []) {
    const [, exp, k, t] = String(r.symbol).split("-");
    const expiry = parseDdMmmYy(exp!);
    const strike = parseStrike(k!);
    const type = parseType(t!);
    const F = pos(r.underlyingPrice);
    if (!expiry || !strike || !type || !F) continue;
    out.push({
      venue: "bybit", instrument: r.symbol, type, strike, expiry, forward: F, ts,
      bidIv: pos(r.bid1Price) ? pos(r.bid1Iv) : undefined,
      askIv: pos(r.ask1Price) ? pos(r.ask1Iv) : undefined,
      markIv: pos(r.markIv),
    });
  }
  return out;
}

export async function fetchBybit(asset: PricerAsset): Promise<VenueSnapshot> {
  const raw = await getJson(bybitUrl(asset));
  if (raw?.retCode !== 0) throw new Error(`bybit retCode ${raw?.retCode}`);
  const fetchedAt = Date.now();
  return { venue: "bybit", fetchedAt, quotes: parseBybit(asset, raw, fetchedAt) };
}
