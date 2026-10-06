// Keeper desk flow, mirror transitions, HTTP auth. Uses in-test doubles of the chain/desk
// interfaces (test-only; product code has no mocks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Keeper } from "../src/keeper/index.js";
import { pdas } from "../src/chain/pdas.js";
import { MemoryRepo } from "../src/db/memory.js";
import { transitions, inferClosedStatus } from "../src/loops/mirror.js";
import { secretOk } from "../src/http/server.js";
import type { ChainSnapshot, PlanState, RoundState } from "../src/chain/types.js";

const PROGRAM = new PublicKey("4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe");
const ASSET = Keypair.generate().publicKey.toBase58();
const PLAN = Keypair.generate().publicKey.toBase58();
const P = pdas(PROGRAM);
const FRI = Date.parse("2026-10-09T08:00:00Z") / 1000;
const plan: PlanState = {
  pubkey: PLAN, owner: "Owner", asset: ASSET, side: "Buy", phase: "Accumulate", quick: false, targetStrike: 113_000_000n, exitStrike: 0n, strikeMin: 113_000_000n,
  strikeMax: 113_000_000n, callStrikeMin: 0n, callStrikeMax: 0n, lockStrike: true, sizeTotal: 200_000_000n, sizeFilled: 0n, collateralPrincipal: 22_600_000n, lendShares: 1n,
  pendingSettlement: null, minPremiumBpsPerDay: 10, maxExpirySecs: 30 * 86400, horizonEnd: FRI + 30 * 86400, maxRoundsPerDay: 6, roundsToday: 0, dayIndex: 0, roundCount: 3,
  activeRound: null, paused: false, status: "Active",
};
const snap = (withEpoch: boolean): ChainSnapshot => ({
  now: Date.parse("2026-10-07T08:05:00Z") / 1000, config: { admin: "A", agent: "K", paused: false, feeBps: 1000, feeRecipient: "F" },
  assets: [{ pubkey: ASSET, mint: "So11111111111111111111111111111111111111112", decimals: 9, pythFeedId: "ef", strikeTick: 1_000_000n, maxConfBps: 50, maxSpotMoveBps: 50, maxSpotAgeSecs: 600, enabled: true, symbol: "SOL" }],
  plans: [plan], rounds: [], pool: null,
  epochs: withEpoch ? [{ pubkey: P.epoch(new PublicKey(ASSET), "Std", FRI).toBase58(), asset: ASSET, kind: "Std", expiry: FRI, nBuckets: 10, bucketSecs: 180, bucketToleranceSecs: 2, samples: [], sampleMask: 0, settlePrice: 0n, status: "Open" }] : [],
});
const proposal = (strike: string) => ({ action: "open" as const, strike, size: "200000000", expiry: FRI, auction_secs: 60, premium_start: "130000", premium_floor: "81000", rationale: "r" });
const result = (strike: string) => ({
  input: {}, final: { status: "open", proposal: proposal(strike), reason: "" }, memo: { quant_proposal: [], clef_answers: [] }, memo_json: "{}",
  memo_hash: new Uint8Array(32).fill(7), memo_hash_hex: "07".repeat(32), steps: [], card: null, plan: null,
}) as any;

function harness(withEpoch: boolean, openRound: (args: any) => Promise<string>) {
  const calls: any[] = [];
  const retries: string[] = [];
  const chain: any = { programId: PROGRAM, openRound: async (_kp: Keypair, _p: PublicKey, a: any) => { calls.push(a); return openRound(a); } };
  const snapshots: any = { get: async () => snap(withEpoch), invalidate() {}, peek: () => snap(withEpoch) };
  const desk: any = {
    runDesk: async () => result("120000000"), // out of bounds on purpose (strike > strike_max)
    retryWithChainError: async (_r: any, code: string) => { retries.push(code); return result("113000000"); },
  };
  const repo = new MemoryRepo();
  return { keeper: new Keeper({ chain, snapshots, signer: Keypair.generate(), repo, desk, quickEnabled: false, now: () => Date.parse("2026-10-07T08:05:00Z") }), calls, retries, repo };
}

test("on-chain rejection: recorded with code + tx sig, exactly one retry, retry submitted as-is", async () => {
  const h = harness(true, async (a) => {
    if (a.strike === 120_000_000n) { const e: any = new Error("tx SIG failed on-chain"); e.signature = "FailSig"; e.logs = ["Program log: AnchorError Error Code: StrikeOutOfBounds. Error Number: 6008."]; throw e; }
    return "OkSig";
  });
  await h.keeper.runDeskForPlan(plan);
  assert.deepEqual(h.retries, ["StrikeOutOfBounds"]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].strike, 120_000_000n, "first proposal submitted unfiltered");
  assert.equal(h.calls[0].roundIndex, 3);
  assert.deepEqual([...h.calls[0].memoHash], new Array(32).fill(7));
  const runs = [...h.repo.deskRuns.values()];
  assert.deepEqual(runs.map((r) => [r.status, r.error_code ?? null, r.tx_sig ?? null]), [["rejected", "StrikeOutOfBounds", "FailSig"], ["submitted", null, "OkSig"]]);
});
test("missing epoch: EpochNotFound (off-chain), no tx sent, one retry", async () => {
  const h = harness(false, async () => "never");
  await h.keeper.runDeskForPlan(plan);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.retries, ["EpochNotFound"]);
  const runs = [...h.repo.deskRuns.values()];
  assert.equal(runs[0]!.status, "offchain_error");
  assert.equal(runs[0]!.error_code, "EpochNotFound");
});
test("std desk finishing after 08:30 → WindowMissed (off-chain), nothing sent", async () => {
  const h = harness(true, async () => "never");
  (h.keeper as any).d.now = () => Date.parse("2026-10-07T08:31:00Z");
  await h.keeper.runDeskForPlan(plan);
  assert.equal(h.calls.length, 0);
  assert.equal([...h.repo.deskRuns.values()][0]!.error_code, "WindowMissed");
  assert.deepEqual(h.retries, [], "no desk retry after the window closed");
});
test("transient send failure is not treated as a rejection (no desk retry)", async () => {
  const h = harness(true, async () => { throw new Error("fetch failed"); });
  await h.keeper.runDeskForPlan(plan);
  assert.deepEqual(h.retries, []);
  assert.equal([...h.repo.deskRuns.values()][0]!.status, "submit_failed");
});

const round = (o: Partial<RoundState>): RoundState => ({
  pubkey: "R", plan: PLAN, asset: ASSET, kind: "Put", strike: 113_000_000n, size: 200_000_000n, notional: 22_600_000n, epoch: "E", expiry: FRI, auctionStart: 0,
  auctionSecs: 60, poolDelaySecs: 30, rentPayer: "K", premiumStart: 1n, premiumFloor: 1n, spotAtOpen: 0n, maker: "M", makerIsPool: false, premiumPaid: 500_000n,
  feePaid: 50_000n, exercised: 0, settlePrice: 0n, memoHash: "", status: "Auction", ...o,
});
test("mirror: Auction→Live = RoundTaken (after-fee premium); vanished Live round on resolved epoch = not filled", () => {
  const a = { ...snap(true), rounds: [round({})] };
  const b = { ...snap(true), rounds: [round({ status: "Live" })] };
  const ev = transitions(a, b);
  assert.equal(ev[0]!.type, "RoundTaken");
  assert.equal((ev[0] as any).premiumUsdc, 0.45);
  const c = { ...snap(true), rounds: [], epochs: [{ ...snap(true).epochs[0]!, pubkey: "E", status: "Resolved" as const, settlePrice: 119_000_000n }] };
  const ev2 = transitions(b, c);
  assert.deepEqual([ev2[0]!.type, (ev2[0] as any).exercised], ["RoundResolved", false]);
  assert.equal(inferClosedStatus(round({ status: "Auction" }), c), "Cancelled");
  assert.equal(inferClosedStatus(round({ status: "Live" }), c), "Resolved");
});
test("http shared secret: fail closed, constant-time compare, Bearer accepted", () => {
  assert.equal(secretOk("abc", undefined), false);
  assert.equal(secretOk("Bearer s3cret", "s3cret"), true);
  assert.equal(secretOk("s3cret", "s3cret"), true);
  assert.equal(secretOk("s3cre", "s3cret"), false);
});
