// Pricer service: refreshes venue snapshots + Pyth spot every ~10 s, prices on demand from the cache.
import { logger } from "../log.js";
import { FEED_IDS, getLatestPrice, type PythPrice } from "../pyth/hermes.js";
import { priceOption, type PriceFailure, type PriceResult } from "./consensus.js";
import type { OptType } from "./bs.js";
import type { PricerAsset, VenueSnapshot } from "./types.js";
import { fetchAllVenues } from "./venues/index.js";

export * from "./consensus.js";
export type { OptType } from "./bs.js";
export type { PricerAsset, VenueSnapshot } from "./types.js";

const log = logger("pricer");

/** `refreshedAt` stamps the venue refresh; `spotFetchedAt` stamps the last *successful* Pyth fetch (a retained spot keeps its old stamp). */
export interface AssetState { snapshots: VenueSnapshot[]; spot?: PythPrice; refreshedAt: number; spotFetchedAt?: number }

/** Reject quotes when the Pyth spot's publishTime is older than this (W-H1). Env PRICER_MAX_SPOT_AGE_SECS, default 45. */
export function maxSpotAgeMs(): number {
  const n = Number(process.env.PRICER_MAX_SPOT_AGE_SECS);
  return (Number.isFinite(n) && n > 0 ? n : 45) * 1000;
}

export class Pricer {
  private state = new Map<PricerAsset, AssetState>();
  constructor(public readonly assets: PricerAsset[] = ["SOL"], private now: () => number = Date.now) {}
  /** Install a state directly (replaying saved real snapshots in tests / backfills). */
  seed(asset: PricerAsset, st: AssetState) { this.state.set(asset, st); }

  async refresh(asset: PricerAsset): Promise<AssetState> {
    const [snapshots, spot] = await Promise.all([
      fetchAllVenues(asset),
      getLatestPrice(FEED_IDS[asset]).catch((e) => { log.warn("pyth spot failed", { asset, err: (e as Error).message }); return undefined; }),
    ]);
    const prev = this.state.get(asset);
    // Never re-stamp a retained spot as fresh: keep its previous fetch stamp; quote() gates on spot.publishTime anyway.
    const st: AssetState = spot
      ? { snapshots, spot, refreshedAt: Date.now(), spotFetchedAt: Date.now() }
      : { snapshots, spot: prev?.spot, refreshedAt: Date.now(), spotFetchedAt: prev?.spotFetchedAt };
    if (!spot && st.spot) log.warn("pyth spot retained from earlier fetch", { asset, spotAgeSecs: Math.round((this.now() - st.spot.publishTime * 1000) / 1000) });
    this.state.set(asset, st);
    log.debug("refreshed", { asset, venues: snapshots.map((s) => ({ v: s.venue, n: s.quotes.length, err: s.error })), spot: st.spot?.price });
    return st;
  }

  async refreshAll() {
    for (const a of this.assets) await this.refresh(a);
  }

  get(asset: PricerAsset) { return this.state.get(asset); }

  /**
   * Price from the cache (refreshes first if the cache is empty or > 25 s old — quotes go stale at 30 s).
   * `valuationNowMs` values the option as of that time (default now); quote staleness still uses the wall clock.
   */
  async quote(asset: PricerAsset, type: OptType, strike: number, expiryMs: number, size: number, quick: boolean, valuationNowMs?: number): Promise<PriceResult | PriceFailure> {
    let st = this.state.get(asset);
    if (!st || this.now() - st.refreshedAt > 25_000) st = await this.refresh(asset);
    if (!st.spot) return { ok: false, reason: "no Pyth spot", venues: [], rejected: [] };
    const spotAgeMs = this.now() - st.spot.publishTime * 1000;
    if (spotAgeMs > maxSpotAgeMs()) return { ok: false, reason: `Pyth spot stale (${Math.round(spotAgeMs / 1000)} s old)`, venues: [], rejected: [] };
    return priceOption({ asset, type, strike, expiry: expiryMs, size, quick, spot: st.spot.price, now: this.now(), valuationNow: valuationNowMs }, st.snapshots);
  }
}
