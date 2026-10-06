// Minimal Hermes client (raw fetch so callers see HTTP status codes).
// Reads PYTH_HERMES_API_KEY from env; never logs it.
export const HERMES_BETA = "https://hermes-beta.pyth.network";
export const HERMES_MAINNET = "https://hermes.pyth.network";

export const FEED_IDS = {
  SOL_USD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC_USD: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
} as const;

export interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
  metadata?: { slot?: number; proof_available_time?: number; prev_publish_time?: number };
}
export interface HermesResponse {
  status: number;
  binary?: { encoding: string; data: string[] };
  parsed?: HermesParsed[];
  raw?: string;
}

function authHeaders(): Record<string, string> {
  const key = process.env.PYTH_HERMES_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function get(url: string, auth = true): Promise<HermesResponse> {
  const res = await fetch(url, { headers: auth ? authHeaders() : {} });
  const text = await res.text();
  if (!res.ok) return { status: res.status, raw: text.slice(0, 300) };
  const j = JSON.parse(text);
  return { status: res.status, binary: j.binary, parsed: j.parsed };
}

const q = (ids: string[]) => ids.map((i) => `ids[]=${i}`).join("&");

/** Latest update(s), base64-encoded accumulator data. */
export function getLatest(base: string, ids: string[], auth = true) {
  return get(`${base}/v2/updates/price/latest?${q(ids)}&encoding=base64&parsed=true`, auth);
}

/** Historical update at a publish_time (unix seconds). */
export function getAt(base: string, ids: string[], publishTime: number, auth = true) {
  return get(`${base}/v2/updates/price/${publishTime}?${q(ids)}&encoding=base64&parsed=true`, auth);
}
