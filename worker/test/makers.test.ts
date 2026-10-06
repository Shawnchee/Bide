import { test } from "node:test";
import assert from "node:assert/strict";
import { drawSpread, makerBid, makerDecide, DEFAULT_PROFILES, SPREAD_MIN, SPREAD_MAX } from "../src/makers/strategy.js";
import type { RoundState } from "../src/chain/types.js";

const r: RoundState = {
  pubkey: "R", plan: "P", asset: "A", kind: "Put", strike: 113_000_000n, size: 200_000_000n, notional: 22_600_000n, epoch: "E", expiry: 0,
  auctionStart: 1000, auctionSecs: 30, poolDelaySecs: 10, rentPayer: "K", premiumStart: 130_000n, premiumFloor: 70_000n, spotAtOpen: 0n,
  maker: null, makerIsPool: false, premiumPaid: 0n, feePaid: 0n, exercised: 0, settlePrice: 0n, memoHash: "", status: "Auction",
};
const inv = { usdc: 50_000_000n, asset: 1_000_000_000n, openNotional: 0n };
const prof = DEFAULT_PROFILES[0]!;

test("spread draws stay in [0.02, 0.14]", () => {
  assert.equal(drawSpread(() => 0), SPREAD_MIN);
  assert.ok(Math.abs(drawSpread(() => 1) - SPREAD_MAX) < 1e-12);
  for (let i = 0; i < 1000; i++) { const s = drawSpread(); assert.ok(s >= SPREAD_MIN && s <= SPREAD_MAX); }
});
test("bid = fair × (1 − s)", () => assert.equal(makerBid(100_000, 0.1), 90_000n));
test("waits while price > bid, takes once price ≤ bid", () => {
  const bid = 100_000n; // price hits 100_000 at elapsed = 30×30k/60k = 15 s
  assert.equal(makerDecide(r, bid, inv, prof, 1010).act, "wait");
  const d = makerDecide(r, bid, inv, prof, 1015);
  assert.equal(d.act, "take");
  assert.equal(makerDecide(r, bid, inv, prof, 1035).act, "take", "after auction_secs price = floor");
  assert.equal(makerDecide(r, bid, inv, prof, 1041).act, "skip", "maker window over");
});
test("skips: bid below floor, inventory cap, no WSOL for a put, no USDC for a call", () => {
  assert.equal((makerDecide(r, 60_000n, inv, prof, 1035) as any).reason, "bid below floor");
  assert.equal((makerDecide(r, 100_000n, { ...inv, openNotional: prof.maxOpenNotional }, prof, 1015) as any).reason, "inventory cap");
  assert.equal((makerDecide(r, 100_000n, { ...inv, asset: 1n }, prof, 1015) as any).reason, "insufficient asset (WSOL)");
  assert.equal((makerDecide({ ...r, kind: "Call" }, 100_000n, { ...inv, usdc: 1_000_000n }, prof, 1015) as any).reason, "insufficient USDC");
});
test("two bots with fresh spreads produce different winners over many rounds", () => {
  let w1 = 0, w2 = 0;
  for (let i = 0; i < 500; i++) {
    const b1 = makerBid(100_000 * 0.97, drawSpread()), b2 = makerBid(100_000 * 1.03, drawSpread()) // ±2% vol ≈ ±3% price near the money;
    if (b1 > b2) w1++; else w2++;
  }
  assert.ok(w1 > 50 && w2 > 50, `${w1} vs ${w2}`);
});
import { wrapAmount } from "../src/makers/wsol.js";
test("wsol top-up keeps the native reserve", () => {
  const S = 1_000_000_000n;
  assert.equal(wrapAmount(4n * S, 0n, S, S / 2n), S);
  assert.equal(wrapAmount(4n * S, S, S, S / 2n), 0n);
  assert.equal(wrapAmount(S, 0n, 2n * S, S / 2n), S / 2n);
  assert.equal(wrapAmount(S / 4n, 0n, S, S / 2n), 0n);
});
