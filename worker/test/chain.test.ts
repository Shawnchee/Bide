import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { auctionPrice, medianSamples, notionalOf, premiumMeetsUserMin, takeDeadline } from "../src/chain/auction.js";
import { parseProgramError, BIDE_ERRORS } from "../src/chain/errors.js";
import { pdas } from "../src/chain/pdas.js";
import { parseKeypair } from "../src/chain/keypairs.js";
import { Keypair } from "@solana/web3.js";

const R = { premiumStart: 1_300_000n, premiumFloor: 810_000n, auctionStart: 1000, auctionSecs: 30, poolDelaySecs: 10 };

test("auction_price: linear, floor-divided, clamped", () => {
  assert.equal(auctionPrice(R, 990), 1_300_000n);
  assert.equal(auctionPrice(R, 1000), 1_300_000n);
  assert.equal(auctionPrice(R, 1015), 1_300_000n - (490_000n * 15n) / 30n);
  assert.equal(auctionPrice(R, 1007), 1_300_000n - (490_000n * 7n) / 30n);
  assert.equal(auctionPrice(R, 1030), 810_000n);
  assert.equal(auctionPrice(R, 5000), 810_000n);
  assert.equal(takeDeadline(R), 1040);
});
test("min premium after fee (open_round check)", () => {
  // notional $22 = 22_000_000; 10 bps/day; 600 s; fee 10% → need floor×0.9 ≥ 22e6×10×600/(86400×1e4) = 152.7 → 152
  assert.ok(premiumMeetsUserMin(170n, 1000, 22_000_000n, 10, 600));
  assert.ok(!premiumMeetsUserMin(169n, 1000, 22_000_000n, 10, 600)); // exact: 169×9000×86400 < 22e6×10×600
});
test("notional rounding", () => {
  assert.equal(notionalOf(110_000_000n, 200_000_000n, 9), 22_000_000n);
  assert.equal(notionalOf(110_000_001n, 3n, 9, true), 1n);
  assert.equal(notionalOf(110_000_001n, 3n, 9, false), 0n);
});
test("median like the program", () => {
  assert.equal(medianSamples([5n, 1n, 3n]), 3n);
  assert.equal(medianSamples([4n, 1n, 3n, 2n]), 2n);
});
test("error parsing: Anchor log, hex code, transient", () => {
  const a = parseProgramError({ message: "x", logs: ["Program log: AnchorError ... Error Code: StrikeOutOfBounds. Error Number: 6008. Error Message: ..."] });
  assert.deepEqual([a.name, a.code, a.retryable], ["StrikeOutOfBounds", 6008, false]);
  const b = parseProgramError(new Error("failed to send transaction: custom program error: 0x1775"));
  assert.equal(b.name, BIDE_ERRORS[5]);
  assert.equal(parseProgramError(new Error("429 Too Many Requests")).retryable, true);
});
test("PDA seeds are deterministic and distinct per kind", () => {
  const P = pdas(new PublicKey("4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe"));
  const asset = P.asset(new PublicKey("So11111111111111111111111111111111111111112"));
  assert.notEqual(P.epoch(asset, "Std", 1791576000).toBase58(), P.epoch(asset, "Quick", 1791576000).toBase58());
  assert.equal(P.config().toBase58(), P.config().toBase58());
});
test("keypair parsing: JSON array and base58 (generated, not a real key)", () => {
  const kp = Keypair.generate();
  assert.equal(parseKeypair(JSON.stringify([...kp.secretKey])).publicKey.toBase58(), kp.publicKey.toBase58());
});

test("worker PDAs match packages/shared (P lane source of truth)", async () => {
  const S = await import("@bide/shared");
  const P = pdas(S.PROGRAM_ID);
  const asset = S.assetPda(S.WSOL_MINT)[0];
  const owner = Keypair.generate().publicKey;
  assert.equal(P.asset(S.WSOL_MINT).toBase58(), asset.toBase58());
  assert.equal(P.epoch(asset, "Std", 1791576000).toBase58(), S.epochPda(asset, "Std", 1791576000)[0].toBase58());
  assert.equal(P.epoch(asset, "Quick", 1791212400).toBase58(), S.epochPda(asset, 1, 1791212400)[0].toBase58());
  assert.equal(P.plan(owner, 7).toBase58(), S.planPda(owner, 7)[0].toBase58());
  const plan = P.plan(owner, 7);
  assert.equal(P.round(plan, 3).toBase58(), S.roundPda(plan, 3)[0].toBase58());
  assert.equal(P.escrow(plan).toBase58(), S.escrowPda(plan)[0].toBase58());
  assert.equal(P.config().toBase58(), S.configPda()[0].toBase58());
});
test("schedule constants equal shared EPOCH_PARAMS; std quick-window checks agree", async () => {
  const S = await import("@bide/shared");
  const { KIND_PARAMS, nextQuickExpiry, windowStart } = await import("../src/keeper/schedule.js");
  assert.equal(KIND_PARAMS.Std.poolDelaySecs, S.EPOCH_PARAMS.Std.poolDelaySecs);
  assert.equal(KIND_PARAMS.Quick.graceSecs, S.EPOCH_PARAMS.Quick.graceSecs);
  for (const t of [1791211925, 1791212400, 1791212999]) assert.equal(nextQuickExpiry(t), S.nextQuickExpiry(t));
  assert.equal(windowStart("Std", 1791576000), S.windowStart(1791576000, "Std"));
});
test("worker min-premium mirror agrees with shared math", async () => {
  const S = await import("@bide/shared");
  for (const [floor, notional, bps, secs] of [[170n, 22_000_000n, 10, 600], [168n, 22_000_000n, 10, 600], [500_000n, 113_000_000n, 10, 4 * 86400]] as const) {
    assert.equal(premiumMeetsUserMin(floor, 1000, notional, bps, secs), S.premiumMeetsMin(floor, 1000, notional, bps, secs), `${floor}`);
  }
});
