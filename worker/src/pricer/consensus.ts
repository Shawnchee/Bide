// Consensus + Black-Scholes + auction anchors (BUILD §4.1 steps 5–7, SPEC §6).
import { blackPrice, itmProbability, type OptType, YEAR_SECS } from "./bs.js";
import { filterQuotes, median, venueIv, type VenueIv, type VenueReject, type DropReason } from "./surface.js";
import type { PricerAsset, VenueSnapshot } from "./types.js";

export const MIN_VENUES = 2;
export const START_MULT = 1.3;
export const FLOOR_MULT = 0.9;
export const USDC_DECIMALS = 6;

export interface PriceRequest {
  asset: PricerAsset;
  type: OptType; // put = Buy plan, call = Sell plan
  strike: number; // USD per 1 asset
  expiry: number; // ms
  size: number; // whole asset units (e.g. 0.2 SOL)
  quick: boolean;
  spot: number; // Pyth spot, USD
  now: number; // ms
}

export interface PriceResult {
  ok: true;
  asset: PricerAsset;
  type: OptType;
  strike: number;
  expiry: number;
  size: number;
  spot: number;
  tYears: number;
  fairIv: number;
  bidIv: number;
  /** USDC base units (6 dp), totals for `size`. */
  fairPremium: number;
  bidPremium: number;
  start: number;
  floor: number;
  /** floor was raised above bid×0.9 so that fair ≤ start ≤ 3×floor can hold. */
  floorRaised: boolean;
  fillProbability: number;
  venues: VenueIv[];
  rejected: VenueReject[];
  quick_pricing: boolean;
  ts: number;
}
export interface PriceFailure { ok: false; reason: string; venues: VenueIv[]; rejected: VenueReject[] }

export interface Anchors { fairPremium: number; bidPremium: number; start: number; floor: number; floorRaised: boolean }

/**
 * start = fair×1.3, floor = bid×0.9 (USDC units, rounded up — in the user's favour), then clamp so that
 * floor ≤ fair ≤ start and start ≤ 3×floor (the program rejects premium_start > 3×premium_floor).
 * If 3×floor < fair, start is lowered first; if it would drop below fair, floor is raised to ⌈fair/3⌉.
 */
export function auctionAnchors(fairPremium: number, bidPremium: number): Anchors {
  const fair = Math.max(0, Math.round(fairPremium));
  const bid = Math.max(0, Math.round(bidPremium));
  let floor = Math.min(Math.ceil(bid * FLOOR_MULT), fair);
  let start = Math.ceil(fair * START_MULT);
  let floorRaised = false;
  if (start > 3 * floor) start = Math.max(3 * floor, 0);
  if (start < fair) {
    floor = Math.ceil(fair / 3);
    floorRaised = true;
    start = Math.min(Math.ceil(fair * START_MULT), 3 * floor);
  }
  return { fairPremium: fair, bidPremium: bid, start, floor, floorRaised };
}

export function priceOption(req: PriceRequest, snapshots: VenueSnapshot[]): PriceResult | PriceFailure {
  const venues: VenueIv[] = [];
  const rejected: VenueReject[] = [];
  for (const snap of snapshots) {
    if (snap.error) { rejected.push({ venue: snap.venue, reason: `fetch failed: ${snap.error}` }); continue; }
    const { kept, dropped } = filterQuotes(snap.quotes, req.now);
    const r = venueIv(snap.venue, kept, req.strike, req.expiry, req.now, req.quick);
    if ("reason" in r) rejected.push({ venue: r.venue, reason: `${r.reason} (kept ${kept.length}/${snap.quotes.length}; dropped ${fmtDropped(dropped)})` });
    else venues.push(r);
  }
  if (venues.length < MIN_VENUES) return { ok: false, reason: `need ≥${MIN_VENUES} venues, have ${venues.length}`, venues, rejected };
  if (!(req.spot > 0) || !(req.size > 0)) return { ok: false, reason: "bad spot/size", venues, rejected };

  const fairIv = median(venues.map((v) => v.midIv));
  const bidIv = median(venues.map((v) => v.bidIv));
  const T = (req.expiry - req.now) / 1000 / YEAR_SECS;
  const scale = req.size * 10 ** USDC_DECIMALS;
  const fairPx = blackPrice(req.type, req.spot, req.strike, T, fairIv) * scale;
  const bidPx = blackPrice(req.type, req.spot, req.strike, T, bidIv) * scale;
  const a = auctionAnchors(fairPx, bidPx);
  return {
    ok: true, asset: req.asset, type: req.type, strike: req.strike, expiry: req.expiry, size: req.size, spot: req.spot,
    tYears: T, fairIv, bidIv, ...a,
    fillProbability: itmProbability(req.type, req.spot, req.strike, T, fairIv),
    venues, rejected, quick_pricing: venues.some((v) => v.method === "flat_nearest"), ts: req.now,
  };
}

function fmtDropped(d: Record<DropReason, number>) {
  return Object.entries(d).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",") || "none";
}
