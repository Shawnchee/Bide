// Fetch REAL Hermes (mainnet) SOL/USD accumulator updates for every bucket start of the most recent completed
// quick epoch (10 × 10 s before a 10-min boundary) + one update at bucket0_start + 1 (negative case).
// Saves tests/fixtures/pyth/hermes_quick_epoch.json for the LiteSVM real-VAA post_sample test. 1 req/s (rate limit).
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/chain.js";
import { HERMES_MAINNET, FEED_IDS, getAt } from "./pyth/hermes.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = Math.floor(Date.now() / 1000);
const expiry = Math.floor((now - 15) / 600) * 600;
const ws = expiry - 100;
const times = [...Array.from({ length: 10 }, (_, b) => ws + b * 10), ws + 1];
const updates: { t: number; publish_time: number; prev_publish_time?: number; base64: string }[] = [];
for (const t of times) {
  const r = await getAt(HERMES_MAINNET, [FEED_IDS.SOL_USD], t);
  if (r.status !== 200) throw new Error(`hermes ${t}: ${r.status} ${r.raw}`);
  updates.push({ t, publish_time: r.parsed![0].price.publish_time, prev_publish_time: r.parsed![0].metadata?.prev_publish_time, base64: r.binary!.data[0] });
  console.log(t, "→ publish_time", r.parsed![0].price.publish_time, "price", r.parsed![0].price.price);
  await sleep(1100);
}
mkdirSync(join(ROOT, "tests/fixtures/pyth"), { recursive: true });
writeFileSync(join(ROOT, "tests/fixtures/pyth/hermes_quick_epoch.json"), JSON.stringify({ expiry, window_start: ws, updates }, null, 1));
console.log("saved expiry", expiry);
