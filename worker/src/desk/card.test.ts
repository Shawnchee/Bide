import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCard } from "./card.js";
import { EXP, NOW_MS, fixturePlan } from "./testlib.js";
import type { DeskFinal } from "./types.js";

const final: DeskFinal = {
  status: "open",
  reason: "",
  proposal: { action: "open", strike: "110000000", size: "1500000000", expiry: EXP.w3, auction_secs: 30, premium_start: "9000000", premium_floor: "5600000", rationale: "x" },
};
const traces = [{ call_id: "t", name: "lend_apy", args: {}, ok: true, result: { devnet_apy_bps: 520, mainnet_reference_apy_bps: 610 }, started_at: 0, duration_ms: 0, attempt: 0 }];
const BANNED = /\b(put|call|strike|premium|option|options|expiry|expire|exercise|IV|vol)\b/i;

test("buy card: after-fee pay range, date, crash case, no jargon", () => {
  const c = renderCard({ final, plan: fixturePlan(), traces, now_ms: NOW_MS });
  assert.equal(c.kind, "open");
  assert.equal(c.headline, "You get $5.04–$8.10 now."); // 5.6 and 9.0 minus 10%
  assert.match(c.text, /On Oct 23 at 08:00 UTC, if SOL is below \$110, you buy 1\.5 SOL at \$110 \(165 USDC\)/);
  assert.match(c.warning!, /Checked once, on Oct 23 at 08:00 UTC, not the moment the price touches \$110/);
  assert.match(c.warning!, /crashes to \$82, you still buy at \$110/);
  assert.match(c.text, /about \$0\.41 in Jupiter Lend interest/); // 165 × 5.2% × 17.7d / 365
  assert.equal(c.footnote, "Same price as a limit order, different trigger.");
  assert.doesNotMatch(c.text, BANNED);
});

test("sell card: sells above price, rally case", () => {
  const plan = fixturePlan({ side: "sell", exit_strike: "150000000" });
  const c = renderCard({ final: { ...final, proposal: { ...final.proposal!, strike: "150000000" } }, plan, traces, now_ms: NOW_MS });
  assert.match(c.text, /if SOL is above \$150, you sell 1\.5 SOL at \$150 \(you get 225 USDC\)/);
  assert.match(c.warning!, /rallies to \$187, you still sell at \$150/);
  assert.doesNotMatch(c.text, BANNED);
});

test("skip / vetoed / error cards are plain and deterministic", () => {
  for (const status of ["skip", "vetoed", "error", "flip", "stop"] as const) {
    const a = renderCard({ final: { status, proposal: null, reason: "r" }, plan: fixturePlan({ exit_strike: "150000000" }), traces: [], now_ms: NOW_MS });
    const b = renderCard({ final: { status, proposal: null, reason: "r" }, plan: fixturePlan({ exit_strike: "150000000" }), traces: [], now_ms: NOW_MS });
    assert.equal(a.text, b.text);
    assert.doesNotMatch(a.text, BANNED);
  }
});
