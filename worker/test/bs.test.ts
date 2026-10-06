import { test } from "node:test";
import assert from "node:assert/strict";
import { blackPrice, impliedVol, itmProbability, normCdf } from "../src/pricer/bs.js";

test("normCdf basics", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
});
test("put-call parity with r=0: C − P = F − K", () => {
  const F = 120, K = 113, T = 4 / 365, s = 0.52;
  assert.ok(Math.abs(blackPrice("call", F, K, T, s) - blackPrice("put", F, K, T, s) - (F - K)) < 1e-9);
});
test("known value: ATM put ≈ 0.4·σ·√T·F", () => {
  const F = 100, T = 1 / 365, s = 0.5;
  const p = blackPrice("put", F, F, T, s);
  assert.ok(Math.abs(p - 0.3989 * s * Math.sqrt(T) * F) / p < 0.01);
});
test("impliedVol round-trips", () => {
  for (const [type, K] of [["put", 110], ["call", 130], ["put", 121]] as const) {
    const px = blackPrice(type, 120, K, 10 / 365, 0.63);
    assert.ok(Math.abs(impliedVol(type, px, 120, K, 10 / 365)! - 0.63) < 1e-5);
  }
});
test("impliedVol rejects prices below intrinsic", () => {
  assert.equal(impliedVol("put", 4, 100, 105, 0.1), undefined);
});
test("itmProbability is in (0,1) and monotone in strike for puts", () => {
  const a = itmProbability("put", 120, 110, 7 / 365, 0.5), b = itmProbability("put", 120, 118, 7 / 365, 0.5);
  assert.ok(a > 0 && a < b && b < 1);
});
