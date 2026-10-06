import type { PricerAsset, Venue, VenueSnapshot } from "../types.js";
import { fetchBinance } from "./binance.js";
import { fetchBybit } from "./bybit.js";
import { fetchDeribit } from "./deribit.js";
import { fetchOkx } from "./okx.js";

export const FETCHERS: Record<Venue, (a: PricerAsset) => Promise<VenueSnapshot>> = {
  deribit: fetchDeribit, okx: fetchOkx, bybit: fetchBybit, binance: fetchBinance,
};

/** Fetch all venues in parallel; a failing venue yields an empty snapshot with `error`. */
export async function fetchAllVenues(asset: PricerAsset, venues: Venue[] = Object.keys(FETCHERS) as Venue[]): Promise<VenueSnapshot[]> {
  return Promise.all(venues.map(async (v) => {
    try { return await FETCHERS[v](asset); }
    catch (e) { return { venue: v, fetchedAt: Date.now(), quotes: [], error: (e as Error).message }; }
  }));
}
