import { test } from "node:test";
import assert from "node:assert/strict";
import { filterQuotes, interpSmile, buildSmiles, venueIv } from "../src/pricer/surface.js";
import { auctionAnchors, priceOption } from "../src/pricer/consensus.js";
import { parseDeribit } from "../src/pricer/venues/deribit.js";
import { parseOkx } from "../src/pricer/venues/okx.js";
import { parseBybit } from "../src/pricer/venues/bybit.js";
import { parseBinance } from "../src/pricer/venues/binance.js";
import { parsePythParsed } from "../src/pyth/hermes.js";
import { fixture, FIXTURE_NOW } from "./helpers.js";
import type { Quote, VenueSnapshot } from "../src/pricer/types.js";

const NOW = FIXTURE_NOW;
const H = 3600_000, D = 24 * H;
// Synthetic quote helper for pure-logic tests (test data, not product mocks).
const q = (o: Partial<Quote>): Quote => ({ venue: "okx", instrument: "x", type: "put", strike: 100, expiry: NOW + 7 * D, bidIv: 0.5, askIv: 0.55, forward: 100, ts: NOW, ...o });

test("filters: stale / no bid / no ask / wide spread / expired", () => {
  const { kept, dropped } = filterQuotes([
    q({}), q({ ts: NOW - 31_000 }), q({ bidIv: undefined }), q({ askIv: undefined }), q({ askIv: 0.61 }), q({ expiry: NOW - 1 }),
    q({ askIv: 0.5999 }), // spread 9.99 vol pts → kept
  ], NOW);
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped, { stale: 1, no_bid: 1, no_ask: 1, wide_spread: 1, expired: 1 });
});

test("smile: OTM side preferred, linear in log-moneyness, no extrapolation", () => {
  const smile = buildSmiles([
    q({ strike: 90, type: "put", bidIv: 0.6, askIv: 0.62 }), q({ strike: 90, type: "call", bidIv: 0.9, askIv: 0.92 }),
    q({ strike: 110, type: "call", bidIv: 0.4, askIv: 0.42 }),
  ])[0]!;
  assert.equal(smile.points.length, 2);
  assert.equal(smile.points[0]!.bid, 0.6, "OTM put chosen below forward");
  const k = Math.log(100 / 100), k0 = Math.log(0.9), k1 = Math.log(1.1);
  const w = (k - k0) / (k1 - k0);
  assert.ok(Math.abs(interpSmile(smile, 100)!.bid - (0.6 + w * (0.4 - 0.6))) < 1e-12);
  assert.equal(interpSmile(smile, 89), undefined);
  assert.equal(interpSmile(smile, 111), undefined);
});

test("expiry: total-variance interpolation between listed expiries", () => {
  const e1 = NOW + 1 * D, e2 = NOW + 9 * D;
  const qs = [q({ expiry: e1, strike: 95, bidIv: 0.8, askIv: 0.8 }), q({ expiry: e1, strike: 105, type: "call", bidIv: 0.8, askIv: 0.8 }),
    q({ expiry: e2, strike: 95, bidIv: 0.4, askIv: 0.4 }), q({ expiry: e2, strike: 105, type: "call", bidIv: 0.4, askIv: 0.4 })];
  const r = venueIv("okx", qs, 100, NOW + 5 * D, NOW, false);
  assert.ok(!("reason" in r));
  const want = Math.sqrt((0.64 * 1 + ((0.16 * 9 - 0.64 * 1) * (5 - 1)) / (9 - 1)) / 5);
  assert.ok(Math.abs(r.midIv - want) < 1e-9, `${r.midIv} vs ${want}`);
  assert.equal(r.method, "total_variance");
  assert.ok("reason" in venueIv("okx", qs, 100, NOW + 10 * D, NOW, false), "no extrapolation past longest");
});

test("below shortest expiry: std rejected, quick gets flat IV + flag", () => {
  const qs = [q({ expiry: NOW + D, strike: 95, bidIv: 0.7, askIv: 0.72 }), q({ expiry: NOW + D, strike: 105, type: "call", bidIv: 0.7, askIv: 0.72 })];
  assert.ok("reason" in venueIv("okx", qs, 100, NOW + 600_000, NOW, false));
  const r = venueIv("okx", qs, 100, NOW + 600_000, NOW, true);
  assert.ok(!("reason" in r) && r.method === "flat_nearest" && Math.abs(r.midIv - 0.71) < 1e-12);
});

test("anchors: start=fair×1.3, floor=bid×0.9, clamps hold", () => {
  assert.deepEqual(auctionAnchors(1_000_000, 900_000), { fairPremium: 1_000_000, bidPremium: 900_000, start: 1_300_000, floor: 810_000, floorRaised: false });
  // bid above fair (crossed venues) → floor clamped to fair
  const a = auctionAnchors(1000, 2000);
  assert.ok(a.floor <= a.fairPremium && a.fairPremium <= a.start && a.start <= 3 * a.floor);
  // tiny bid → start ≤ 3×floor forces floor up
  const b = auctionAnchors(1000, 100);
  assert.ok(b.floorRaised && b.floor <= b.fairPremium && b.fairPremium <= b.start && b.start <= 3 * b.floor);
  for (let i = 0; i < 2000; i++) {
    const f = Math.random() * 5e6, bd = Math.random() * 6e6;
    const x = auctionAnchors(f, bd);
    if (x.fairPremium === 0) continue;
    assert.ok(x.floor <= x.fairPremium && x.fairPremium <= x.start && x.start <= 3 * x.floor, JSON.stringify([f, bd, x]));
  }
});

function fixtureSnapshots(): VenueSnapshot[] {
  return [
    { venue: "deribit", fetchedAt: NOW, quotes: parseDeribit("SOL", fixture("deribit_usdc_option.json"), NOW) },
    { venue: "okx", fetchedAt: NOW, quotes: parseOkx("SOL", fixture("okx_sol.json"), NOW) },
    { venue: "bybit", fetchedAt: NOW, quotes: parseBybit("SOL", fixture("bybit_sol.json"), NOW) },
    { venue: "binance", fetchedAt: NOW, quotes: parseBinance("SOL", fixture("binance_mark.json"), fixture("binance_index_sol.json"), NOW) },
  ];
}
const spot = parsePythParsed(fixture("hermes_sol_latest.json").parsed[0]).price;
const FRI = Date.UTC(2026, 9, 9, 8);

test("real snapshots: SOL put spot−5% Fri 9 Oct prices with ≥2 venues and sane IV", () => {
  const strike = Math.round(spot * 0.95);
  const r = priceOption({ asset: "SOL", type: "put", strike, expiry: FRI, size: 1, quick: false, spot, now: NOW }, fixtureSnapshots());
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.venues.length >= 2);
  assert.ok(r.fairIv > 0.2 && r.fairIv < 1.5 && r.bidIv <= r.fairIv + 0.05);
  assert.ok(r.floor <= r.fairPremium && r.fairPremium <= r.start && r.start <= 3 * r.floor);
  assert.ok(r.fairPremium > 50_000 && r.fairPremium < 5_000_000, `fair ${r.fairPremium}`); // $0.05–$5 per SOL
  assert.equal(r.quick_pricing, false);
});
test("real snapshots: size scales premium linearly", () => {
  const base = { asset: "SOL" as const, type: "put" as const, strike: Math.round(spot * 0.95), expiry: FRI, quick: false, spot, now: NOW };
  const a = priceOption({ ...base, size: 1 }, fixtureSnapshots()), b = priceOption({ ...base, size: 0.2 }, fixtureSnapshots());
  assert.ok(a.ok && b.ok && Math.abs(b.fairPremium - a.fairPremium * 0.2) <= 1);
});
test("real snapshots: quick 10-min put gets quick_pricing", () => {
  const r = priceOption({ asset: "SOL", type: "put", strike: Math.round(spot), expiry: NOW + 600_000, size: 0.2, quick: true, spot, now: NOW }, fixtureSnapshots());
  assert.ok(r.ok && r.quick_pricing && r.fairPremium > 0);
});
test("real snapshots: covered call prices too", () => {
  const r = priceOption({ asset: "SOL", type: "call", strike: Math.round(spot * 1.05), expiry: FRI, size: 1, quick: false, spot, now: NOW }, fixtureSnapshots());
  assert.ok(r.ok && r.venues.length >= 2, JSON.stringify(!r.ok && r.rejected));
});
test("fails closed with < 2 venues", () => {
  const snaps = fixtureSnapshots().map((s, i) => (i === 0 ? s : { ...s, quotes: [], error: "down" }));
  const r = priceOption({ asset: "SOL", type: "put", strike: Math.round(spot * 0.95), expiry: FRI, size: 1, quick: false, spot, now: NOW }, snaps);
  assert.equal(r.ok, false);
});
test("everything stale 30 s later → no price", () => {
  const r = priceOption({ asset: "SOL", type: "put", strike: Math.round(spot * 0.95), expiry: FRI, size: 1, quick: false, spot, now: NOW + 120_000 }, fixtureSnapshots());
  assert.equal(r.ok, false);
});
