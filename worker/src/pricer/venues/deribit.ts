// Deribit: get_book_summary_by_currency has prices but no bid/ask IV, so bid/ask IVs are
// implied from bid_price/ask_price with Black-76 on the instrument's own underlying_price
// (forward) — one request instead of ~700 public/ticker calls.
import { impliedVol, YEAR_SECS } from "../bs.js";
import type { PricerAsset, Quote, VenueSnapshot } from "../types.js";
import { getJson, parseDdMmmYy, parseStrike, parseType, pos } from "./common.js";

export function deribitUrl(asset: PricerAsset) {
  // SOL options are linear USDC options; BTC uses the inverse BTC book (prices in BTC).
  const currency = asset === "SOL" ? "USDC" : "BTC";
  return `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
}

export function parseDeribit(asset: PricerAsset, raw: any, fetchedAt: number): Quote[] {
  const prefix = asset === "SOL" ? "SOL_USDC-" : "BTC-";
  const out: Quote[] = [];
  for (const r of raw?.result ?? []) {
    const name: string = r.instrument_name;
    if (!name?.startsWith(prefix)) continue;
    const [, exp, k, t] = name.split("-");
    const expiry = parseDdMmmYy(exp!);
    const strike = parseStrike(k!);
    const type = parseType(t!);
    const F = pos(r.underlying_price);
    if (!expiry || !strike || !type || !F) continue;
    const ts = Number(r.creation_timestamp) || fetchedAt;
    const T = (expiry - ts) / 1000 / YEAR_SECS;
    if (T <= 0) continue;
    const toUsd = asset === "SOL" ? 1 : F; // inverse book: price in BTC
    const bidPx = pos(r.bid_price);
    const askPx = pos(r.ask_price);
    const markIv = pos(r.mark_iv);
    out.push({
      venue: "deribit", instrument: name, type, strike, expiry, forward: F, ts,
      bidIv: bidPx ? impliedVol(type, bidPx * toUsd, F, strike, T) : undefined,
      askIv: askPx ? impliedVol(type, askPx * toUsd, F, strike, T) : undefined,
      markIv: markIv ? markIv / 100 : undefined, // percent → decimal
    });
  }
  return out;
}

export async function fetchDeribit(asset: PricerAsset): Promise<VenueSnapshot> {
  const raw = await getJson(deribitUrl(asset));
  const fetchedAt = Date.now();
  return { venue: "deribit", fetchedAt, quotes: parseDeribit(asset, raw, fetchedAt) };
}
