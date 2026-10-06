import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEarnTokens, parsePrice, RateLimiter } from "../src/jupiter/reference.js";
import { fixture } from "./helpers.js";

test("earn tokens: USDC + WSOL APY in bps", () => {
  const l = parseEarnTokens(fixture("jup_earn_tokens.json"));
  const usdc = l.find((x) => x.symbol === "USDC")!;
  assert.ok(usdc.totalBps > 0 && usdc.totalBps < 5000 && usdc.totalBps === usdc.supplyBps + usdc.rewardsBps);
  assert.ok(l.some((x) => x.symbol === "WSOL" || x.symbol === "SOL"));
});
test("price v3", () => {
  const p = parsePrice(fixture("jup_price_sol.json"))!;
  assert.ok(p > 10 && p < 1000);
});
test("rate limiter spaces calls by the min gap", async () => {
  let clock = 0;
  const slept: number[] = [];
  const rl = new RateLimiter(2000, () => clock, async (ms) => { slept.push(ms); clock += ms; });
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((i) => rl.run(async () => { order.push(clock); return i; })));
  assert.deepEqual(order, [0, 2000, 4000]);
});
