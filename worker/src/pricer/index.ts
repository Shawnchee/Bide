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

export interface AssetState { snapshots: VenueSnapshot[]; spot?: PythPrice; refreshedAt: number }

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
    const st: AssetState = { snapshots, spot: spot ?? this.state.get(asset)?.spot, refreshedAt: Date.now() };
    this.state.set(asset, st);
    log.debug("refreshed", { asset, venues: snapshots.map((s) => ({ v: s.venue, n: s.quotes.length, err: s.error })), spot: st.spot?.price });
    return st;
  }

  async refreshAll() {
    for (const a of this.assets) await this.refresh(a);
  }

  get(asset: PricerAsset) { return this.state.get(asset); }

  /** Price from the cache (refreshes first if the cache is empty or > 25 s old — quotes go stale at 30 s). */
  async quote(asset: PricerAsset, type: OptType, strike: number, expiryMs: number, size: number, quick: boolean): Promise<PriceResult | PriceFailure> {
    let st = this.state.get(asset);
    if (!st || this.now() - st.refreshedAt > 25_000) st = await this.refresh(asset);
    if (!st.spot) return { ok: false, reason: "no Pyth spot", venues: [], rejected: [] };
    return priceOption({ asset, type, strike, expiry: expiryMs, size, quick, spot: st.spot.price, now: this.now() }, st.snapshots);
  }
}
