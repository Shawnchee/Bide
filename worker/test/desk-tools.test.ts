import { test } from "node:test";
import assert from "node:assert/strict";
import { Pricer } from "../src/pricer/index.js";
import { WorkerDeskTools } from "../src/desk-tools.js";
import { JupiterReference } from "../src/jupiter/reference.js";
import { parseDeribit } from "../src/pricer/venues/deribit.js";
import { parseOkx } from "../src/pricer/venues/okx.js";
import { parseBybit } from "../src/pricer/venues/bybit.js";
import { parseBinance } from "../src/pricer/venues/binance.js";
import { parsePythParsed } from "../src/pyth/hermes.js";
import { fixture, FIXTURE_NOW } from "./helpers.js";
import { pricingNowSecs } from "../src/keeper/schedule.js";
import { priceOption } from "../src/pricer/consensus.js";
import { YEAR_SECS } from "../src/pricer/bs.js";

const NOW = FIXTURE_NOW;
function tools() {
  const pricer = new Pricer(["SOL"], () => NOW);
  pricer.seed("SOL", {
    refreshedAt: NOW, spot: parsePythParsed(fixture("hermes_sol_latest.json").parsed[0]),
    snapshots: [
      { venue: "deribit", fetchedAt: NOW, quotes: parseDeribit("SOL", fixture("deribit_usdc_option.json"), NOW) },
      { venue: "okx", fetchedAt: NOW, quotes: parseOkx("SOL", fixture("okx_sol.json"), NOW) },
      { venue: "bybit", fetchedAt: NOW, quotes: parseBybit("SOL", fixture("bybit_sol.json"), NOW) },
      { venue: "binance", fetchedAt: NOW, quotes: parseBinance("SOL", fixture("binance_mark.json"), fixture("binance_index_sol.json"), NOW) },
    ],
  });
  return { pricer, t: new WorkerDeskTools({ pricer, jupiter: new JupiterReference(), chain: null, getSnapshot: async () => null, now: () => NOW }) };
}
const FRI = Date.UTC(2026, 9, 9, 8) / 1000;

test("price_grid converts base units ↔ pricer units and returns string totals for size", async () => {
  const { pricer, t } = tools();
  const g = await t.price_grid({ asset: "SOL", kind: "put", strikes: ["113000000", "50000000"], expiries: [FRI], size: "200000000" });
  const ok = g.cells[0]!, bad = g.cells[1]!;
  assert.equal(ok.error, undefined);
  for (const k of ["fair_premium", "bid_premium", "premium_start", "premium_floor"] as const) assert.match(ok[k], /^\d+$/);
  const direct = await pricer.quote("SOL", "put", 113, FRI * 1000, 0.2, false);
  assert.ok(direct.ok && ok.fair_premium === String(Math.round(direct.fairPremium)));
  assert.ok(BigInt(ok.premium_floor) <= BigInt(ok.fair_premium) && BigInt(ok.premium_start) <= 3n * BigInt(ok.premium_floor));
  assert.ok(bad.error, "far OTM strike → error cell, not a throw");
  assert.match(g.spot, /^\d+$/);
});
test("get_spot returns USDC base units", async () => {
  const s = await tools().t.get_spot({ asset: "SOL" });
  assert.ok(Number(s.price) > 50e6 && Number(s.price) < 500e6);
});
test("draft plan view for preview: bounds per side, scheduled epochs when chain is not live", async () => {
  const { t } = tools();
  const id = t.registerDraft({ asset: "SOL", side: "buy", quick: false, target_strike: "113000000", lock_strike: false, band: "3000000", size_total: "200000000", min_premium_bps_per_day: 10, max_expiry_secs: 30 * 86400, horizon_end: NOW / 1000 + 30 * 86400 });
  const v = await t.get_plan({ plan_id: id });
  assert.deepEqual([v.strike_min, v.strike_max, v.fee_bps, v.asset_decimals], ["110000000", "113000000", 1000, 9]);
  assert.ok(v.open_epochs.some((e) => e.expiry === FRI && e.kind === "std"));
});
test("fill_probability and venue_dispersion on real snapshots", async () => {
  const { t } = tools();
  const f = await t.fill_probability({ asset: "SOL", kind: "put", strike: "113000000", expiry: FRI });
  assert.ok(f.probability > 0.01 && f.probability < 0.5);
  const d = await t.venue_dispersion({ asset: "SOL", expiry: FRI });
  assert.ok(d.venues_used >= 2 && d.iv_spread_vol_pts !== null);
});

// notes/stress-test.md "Fill rate": the desk runs ~180 s before a quick window, i.e. ~780 s to expiry, but the round
// opens at the window start (expiry − 600). Quick cells must be valued from there, so floor ≤ maker fair at take time.
test("pricingNowSecs: quick → max(now, expiry − 600); std → now", () => {
  assert.equal(pricingNowSecs(true, 10_200, 9_420), 9_600);
  assert.equal(pricingNowSecs(true, 10_200, 9_610), 9_610, "inside the window → now");
  assert.equal(pricingNowSecs(false, 100_000, 9_420), 9_420);
});
test("price_grid values a quick epoch from its window open (tte ≈ 600 s, not ≈ 780 s)", async () => {
  const { pricer, t } = tools();
  const nowS = Math.floor(NOW / 1000);
  const E = nowS + 780; // desk run 180 s before the window
  const spot = pricer.get("SOL")!.spot!.price;
  const K = Math.round(spot * 0.996); // near the money (the recording plan's spot −0.4 %)
  const g = await t.price_grid({ asset: "SOL", kind: "put", strikes: [String(K * 1_000_000)], expiries: [E], size: "100000000" });
  const cell = g.cells[0]!;
  assert.equal(cell.error, undefined, String(cell.error));
  const at600 = await pricer.quote("SOL", "put", K, E * 1000, 0.1, true, (E - 600) * 1000);
  const at780 = await pricer.quote("SOL", "put", K, E * 1000, 0.1, true);
  assert.ok(at600.ok && at780.ok);
  assert.ok(Math.abs(at600.tYears * YEAR_SECS - 600) < 1, `priced tte ${at600.tYears * YEAR_SECS}`);
  assert.ok(Math.abs(at780.tYears * YEAR_SECS - 780) < 1);
  assert.equal(cell.fair_premium, String(Math.round(at600.fairPremium)), "grid uses the window-open reference");
  assert.ok(at600.fairPremium < at780.fairPremium);
  // Maker fair at take time: round opened ~5 s into the window, maker prices with the wall clock (makers/index.ts view()).
  const st = pricer.get("SOL")!;
  const maker = priceOption({ asset: "SOL", type: "put", strike: K, expiry: E * 1000, size: 0.1, quick: true, spot, now: NOW, valuationNow: (E - 595) * 1000 }, st.snapshots);
  assert.ok(maker.ok);
  assert.ok(BigInt(cell.premium_floor) <= BigInt(Math.round(maker.fairPremium)), `floor ${cell.premium_floor} > maker fair ${maker.fairPremium}`);
  // Maker stance tools see the same reference as the desk.
  const fp = await t.fill_probability({ asset: "SOL", kind: "put", strike: String(K * 1_000_000), expiry: E });
  assert.equal(fp.probability, at600.fillProbability);
});
test("price_grid std epochs still price from now", async () => {
  const { pricer, t } = tools();
  const g = await t.price_grid({ asset: "SOL", kind: "put", strikes: ["113000000"], expiries: [FRI], size: "200000000" });
  const direct = await pricer.quote("SOL", "put", 113, FRI * 1000, 0.2, false);
  assert.ok(direct.ok && g.cells[0]!.fair_premium === String(Math.round(direct.fairPremium)));
});
