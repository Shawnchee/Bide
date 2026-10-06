export type Venue = "deribit" | "okx" | "bybit" | "binance";
export const VENUES: Venue[] = ["deribit", "okx", "bybit", "binance"];

/** One normalised option quote. IVs are decimals (0.55 = 55%). Times in ms since epoch. */
export interface Quote {
  venue: Venue;
  instrument: string;
  type: "put" | "call";
  strike: number; // USD per 1 asset
  expiry: number; // ms, 08:00 UTC
  bidIv?: number; // undefined = no bid
  askIv?: number; // undefined = no ask
  markIv?: number;
  forward: number; // venue forward / underlying used for log-moneyness
  ts: number; // quote timestamp (ms)
}

export interface VenueSnapshot {
  venue: Venue;
  fetchedAt: number;
  quotes: Quote[];
  error?: string;
}

export type PricerAsset = "SOL" | "BTC";
