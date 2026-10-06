// Manual live check: `pnpm --filter @bide/worker exec tsx src/pricer/live.ts`
import { Pricer } from "./index.js";
import { nextDailyExpiry, nextFridayExpiry, nextQuickExpiry } from "../keeper/schedule.js";

const p = new Pricer(["SOL"]);
const st = await p.refresh("SOL");
const spot = st.spot!.price;
console.log("Pyth SOL/USD", spot.toFixed(4), "conf", st.spot!.conf.toFixed(4), "publish", new Date(st.spot!.publishTime * 1000).toISOString());
for (const s of st.snapshots) console.log(`  ${s.venue.padEnd(8)} quotes=${s.quotes.length}${s.error ? " ERROR " + s.error : ""}`);
const now = Math.floor(Date.now() / 1000);
const K = (pct: number) => Math.round(spot * (1 + pct)); // $1 tick
const cases = [
  { label: "1-day (next 08:00 UTC), spot−5%", exp: nextDailyExpiry(now), quick: false, strike: K(-0.05) },
  { label: "1-day (next 08:00 UTC), spot−2%", exp: nextDailyExpiry(now), quick: false, strike: K(-0.02) },
  { label: "next Friday 08:00 UTC, spot−5%", exp: nextFridayExpiry(now), quick: false, strike: K(-0.05) },
  { label: "quick 10-min, spot−5%", exp: nextQuickExpiry(now), quick: true, strike: K(-0.05) },
  { label: "quick 10-min, spot−0.4% (recording)", exp: nextQuickExpiry(now), quick: true, strike: K(-0.004) },
];
for (const c of cases) {
  const strike = c.strike;
  for (const type of ["put"] as const) {
    const r = await p.quote("SOL", type, strike, c.exp * 1000, 1, c.quick);
    console.log(`\nSOL ${type} K=$${strike} ${c.label} ${new Date(c.exp * 1000).toISOString()} size=1 SOL`);
    if (!r.ok) { console.log("  FAIL", r.reason, JSON.stringify(r.rejected)); continue; }
    const usd = (u: number) => "$" + (u / 1e6).toFixed(4);
    console.log(`  fairIV=${(r.fairIv * 100).toFixed(2)}% bidIV=${(r.bidIv * 100).toFixed(2)}% T=${(r.tYears * 365).toFixed(3)}d quick_pricing=${r.quick_pricing} P(fill)=${(r.fillProbability * 100).toFixed(1)}%`);
    console.log(`  fair=${usd(r.fairPremium)} bid=${usd(r.bidPremium)} start=${usd(r.start)} floor=${usd(r.floor)} floorRaised=${r.floorRaised}`);
    for (const v of r.venues) console.log(`   ✓ ${v.venue.padEnd(8)} mid=${(v.midIv * 100).toFixed(2)}% bid=${(v.bidIv * 100).toFixed(2)}% ${v.method} fwd=${v.forward.toFixed(3)} kept=${v.quotesKept}`);
    for (const v of r.rejected) console.log(`   ✗ ${v.venue.padEnd(8)} ${v.reason}`);
  }
}
