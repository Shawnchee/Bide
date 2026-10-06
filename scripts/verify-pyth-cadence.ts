// Task 2: for every second in a window, ask Hermes /v2/updates/price/{t} and record status + returned publish_time.
// Usage: tsx verify-pyth-cadence.ts [seconds=300] [base=mainnet|beta] [feed=SOL_USD|BTC_USD] [endOffset=60]
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { HERMES_BETA, HERMES_MAINNET, FEED_IDS, getAt } from "./pyth/hermes.js";
const [secs = "300", b = "mainnet", f = "SOL_USD", endOff = "60"] = process.argv.slice(2);
const base = b === "beta" ? HERMES_BETA : HERMES_MAINNET;
const feed = FEED_IDS[f as keyof typeof FEED_IDS];
const end = Math.floor(Date.now() / 1000) - Number(endOff);
const start = end - Number(secs);
const res: { t: number; status: number; pt?: number; prev?: number; ms: number }[] = [];
const ts = Array.from({ length: Number(secs) }, (_, i) => start + i);
// Sequential with ~1 req/s: Hermes 429s bursts (8 parallel → 429 with Retry-After ~52 s); 1 req/s sustained is fine.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const t of ts) {
  for (;;) {
    const t0 = Date.now();
    const r = await getAt(base, [feed], t);
    if (r.status === 429) { console.error("429 at", t, "— backing off 60 s"); await sleep(60_000); continue; }
    res.push({ t, status: r.status, pt: r.parsed?.[0]?.price.publish_time, prev: r.parsed?.[0]?.metadata?.prev_publish_time, ms: Date.now() - t0 });
    await sleep(800);
    break;
  }
}
res.sort((a, z) => a.t - z.t);
const statuses: Record<number, number> = {};
res.forEach((r) => (statuses[r.status] = (statuses[r.status] ?? 0) + 1));
const exact = res.filter((r) => r.pt === r.t).length;
const deltas: Record<string, number> = {};
res.filter((r) => r.pt !== undefined).forEach((r) => { const k = String(r.pt! - r.t); deltas[k] = (deltas[k] ?? 0) + 1; });
const gaps: Record<string, number> = {};
res.filter((r) => r.pt !== undefined && r.prev !== undefined).forEach((r) => { const k = String(r.pt! - r.prev!); gaps[k] = (gaps[k] ?? 0) + 1; });
// distinct publish_times observed → max gap between consecutive ones
const pts = [...new Set(res.map((r) => r.pt).filter((x): x is number => !!x))].sort();
let maxGap = 0; for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, pts[i] - pts[i - 1]);
const lat = res.map((r) => r.ms).sort((a, z) => a - z);
console.log(JSON.stringify({ base, feed: f, window: [start, end], n: res.length, statuses, exactMatch: exact, returnedMinusRequested: deltas,
  publishMinusPrev: gaps, distinctPublishTimes: pts.length, maxGapBetweenDistinct: maxGap,
  latencyMs: { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)] },
  misses: res.filter((r) => r.pt !== r.t).slice(0, 10) }, null, 1));
