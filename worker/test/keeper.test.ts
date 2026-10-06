import { test } from "node:test";
import assert from "node:assert/strict";
import { planKeeperActions, poolCanTake, eligibleExpiries, inAuctionWindow } from "../src/keeper/plan.js";
import type { ChainSnapshot, EpochState, PlanState, PoolState, RoundState } from "../src/chain/types.js";

const t = (iso: string) => Date.parse(iso) / 1000;
const ASSET = "AssetSOL";
const key = (a: string, k: string, e: number) => `${a}:${k}:${e}`;
// Synthetic chain state for decision logic (test data).
const plan = (o: Partial<PlanState> = {}): PlanState => ({
  pubkey: "Plan1", owner: "Owner", asset: ASSET, side: "Buy", phase: "Accumulate", quick: false, targetStrike: 113_000_000n, exitStrike: 0n,
  strikeMin: 113_000_000n, strikeMax: 113_000_000n, callStrikeMin: 0n, callStrikeMax: 0n, lockStrike: true, sizeTotal: 1_000_000_000n, sizeFilled: 0n,
  collateralPrincipal: 113_000_000n, lendShares: 1n, pendingSettlement: null, minPremiumBpsPerDay: 10, maxExpirySecs: 30 * 86400,
  horizonEnd: t("2026-11-05T00:00:00Z"), maxRoundsPerDay: 6, roundsToday: 0, dayIndex: 0, roundCount: 0, activeRound: null, paused: false, status: "Active", ...o,
});
const round = (o: Partial<RoundState> = {}): RoundState => ({
  pubkey: "Round1", plan: "Plan1", asset: ASSET, kind: "Put", strike: 113_000_000n, size: 200_000_000n, notional: 22_600_000n, epoch: "Ep1",
  expiry: t("2026-10-09T08:00:00Z"), auctionStart: 1000, auctionSecs: 60, poolDelaySecs: 30, rentPayer: "Keeper", premiumStart: 130_000n,
  premiumFloor: 81_000n, spotAtOpen: 119_000_000n, maker: null, makerIsPool: false, premiumPaid: 0n, feePaid: 0n, exercised: 0, settlePrice: 0n,
  memoHash: "", status: "Auction", ...o,
});
const epoch = (o: Partial<EpochState> = {}): EpochState => ({
  pubkey: "Ep1", asset: ASSET, kind: "Std", expiry: t("2026-10-09T08:00:00Z"), nBuckets: 10, bucketSecs: 180, bucketToleranceSecs: 2,
  samples: Array(10).fill(0n), sampleMask: 0, settlePrice: 0n, status: "Open", ...o,
});
const pool = (o: Partial<PoolState> = {}): PoolState => ({
  pubkey: "Pool", paused: false, maxPremiumBpsOfNotional: 150, maxOpenNotional: 1_000_000_000n, maxUtilizationBps: 5000, spendWindowSecs: 86400,
  spendWindowStart: 0, spendWindowCap: 50_000_000n, spendWindowSpent: 0n, lendShares: 0n, reservedUsdc: 0n, reservedWsol: 0n, openNotional: 0n,
  usdcVault: 100_000_000n, wsolVault: 2_000_000_000n, ...o,
});
const snap = (o: Partial<ChainSnapshot>): ChainSnapshot => ({
  now: 0, config: { admin: "A", agent: "K", paused: false, feeBps: 1000, feeRecipient: "F" },
  assets: [{ pubkey: ASSET, mint: "So111", decimals: 9, pythFeedId: "ef0d", strikeTick: 1_000_000n, maxConfBps: 50, maxSpotMoveBps: 50, maxSpotAgeSecs: 600, enabled: true, symbol: "SOL" }],
  plans: [], rounds: [], epochs: [], pool: pool(), ...o,
});
const opts = { quickEnabled: false, epochKey: key };
const types = (xs: { type: string }[]) => xs.map((x) => x.type);

test("opens missing std epochs only", () => {
  const now = t("2026-10-05T15:00:00Z");
  const a = planKeeperActions(snap({}), now, opts).filter((x) => x.type === "open_epoch");
  assert.ok(a.length >= 3);
  const existing = a.map((x: any) => ({ ...epoch(), pubkey: key(x.asset, x.kind, x.expiry), expiry: x.expiry }));
  assert.equal(planKeeperActions(snap({ epochs: existing }), now, opts).filter((x) => x.type === "open_epoch").length, 0);
  const q = planKeeperActions(snap({ epochs: existing }), now, { ...opts, quickEnabled: true }).filter((x) => x.type === "open_epoch");
  assert.equal(q.length, 0, "no quick epochs without an active quick plan (rent)");
});

test("quick epochs are pre-opened only while an active quick plan exists", () => {
  const now = t("2026-10-05T15:00:00Z");
  const std = planKeeperActions(snap({}), now, opts).filter((x) => x.type === "open_epoch");
  const existing = std.map((x: any) => ({ ...epoch(), pubkey: key(x.asset, x.kind, x.expiry), expiry: x.expiry }));
  const quickOpens = (plans: PlanState[]) =>
    planKeeperActions(snap({ epochs: existing, plans }), now, { ...opts, quickEnabled: true }).filter((x) => x.type === "open_epoch");
  const q = quickOpens([plan({ quick: true })]);
  assert.equal(q.length, 3, "three quick epochs");
  assert.ok(q.every((x: any) => x.kind === "Quick"));
  assert.equal(quickOpens([plan({ quick: false })]).length, 0, "std plan only");
  assert.equal(quickOpens([plan({ quick: true, status: "Closed" })]).length, 0, "closed plan");
  assert.equal(quickOpens([plan({ quick: true, paused: true })]).length, 0, "paused plan");
  assert.equal(quickOpens([plan({ quick: true, sizeFilled: 1_000_000_000n })]).length, 0, "filled plan");
  assert.equal(quickOpens([plan({ quick: true, horizonEnd: now - 1 })]).length, 0, "horizon over");
  assert.equal(quickOpens([plan({ quick: true, asset: "OtherAsset" })]).length, 0, "other asset");
});

test("untaken auction: wait until pool window, then pool take, or cancel when caps fail", () => {
  const r = round();
  const noEpochs = (now: number, s: Partial<ChainSnapshot> = {}) => planKeeperActions(snap({ rounds: [r], ...s }), now, opts).filter((x) => x.type.includes("round"));
  assert.deepEqual(noEpochs(1089), []);
  assert.deepEqual(types(noEpochs(1090)), ["pool_take_round"]);
  assert.deepEqual(types(noEpochs(1090, { pool: pool({ paused: true }) })), ["cancel_round"]);
  assert.deepEqual(types(noEpochs(1090, { pool: null })), ["cancel_round"]);
});

test("pool cap mirror", () => {
  const r = round();
  assert.ok(poolCanTake(pool(), r, 9, 0).ok);
  assert.equal(poolCanTake(pool({ maxPremiumBpsOfNotional: 10 }), r, 9, 0).reason, "floor above pool max premium bps");
  assert.equal(poolCanTake(pool({ openNotional: 990_000_000n }), r, 9, 0).reason, "open-notional cap");
  assert.equal(poolCanTake(pool({ wsolVault: 100n }), r, 9, 0).reason, "insufficient free WSOL");
  assert.equal(poolCanTake(pool({ usdcVault: 10n }), round({ kind: "Call" }), 9, 0).reason, "insufficient free USDC");
  assert.equal(poolCanTake(pool({ spendWindowSpent: 50_000_000n, spendWindowStart: 0 }), r, 9, 100).reason, "spend-window cap");
  assert.ok(poolCanTake(pool({ spendWindowSpent: 50_000_000n, spendWindowStart: 0 }), r, 9, 86_400).ok, "window resets");
});

test("sampling only for epochs with live rounds; then resolve → resolve_round → withdraw", () => {
  const e = epoch();
  const now = e.expiry - 1800 + 200; // buckets 0,1 due
  assert.deepEqual(planKeeperActions(snap({ epochs: [e] }), now, opts).filter((x) => x.type === "post_sample"), [], "empty epoch lapses");
  const live = round({ status: "Live", maker: "M1" });
  const ps = planKeeperActions(snap({ epochs: [e], rounds: [live] }), now, opts).filter((x) => x.type === "post_sample") as any[];
  assert.deepEqual(ps.map((x) => [x.bucket, x.publishTime]), [[0, e.expiry - 1800], [1, e.expiry - 1620]]);
  const full = epoch({ sampleMask: 0x3ff, status: "Sampling" });
  assert.deepEqual(types(planKeeperActions(snap({ epochs: [full], rounds: [live] }), e.expiry, opts).filter((x) => !x.type.startsWith("open_epoch"))), ["resolve_epoch"]);
  const resolved = epoch({ status: "Resolved", sampleMask: 0x3ff });
  assert.deepEqual(types(planKeeperActions(snap({ epochs: [resolved], rounds: [live] }), e.expiry + 5, opts).filter((x) => !x.type.startsWith("open_epoch"))), ["resolve_round"]);
  const ex = round({ status: "Resolved", exercised: 2 });
  assert.deepEqual(types(planKeeperActions(snap({ epochs: [resolved], rounds: [ex] }), e.expiry + 5, opts).filter((x) => !x.type.startsWith("open_epoch"))), ["withdraw_collateral"]);
});

test("failed epoch → unwind live rounds; resolve_epoch expects fail after grace with < n−2", () => {
  const e = epoch({ sampleMask: 0b11111 });
  const live = round({ status: "Live", maker: "M1" });
  const a = planKeeperActions(snap({ epochs: [e], rounds: [live] }), e.expiry + 3600, opts).find((x) => x.type === "resolve_epoch") as any;
  assert.equal(a.expect, "fail");
  const failed = epoch({ status: "Failed" });
  assert.deepEqual(types(planKeeperActions(snap({ epochs: [failed], rounds: [live] }), e.expiry + 3700, opts).filter((x) => !x.type.startsWith("open_epoch"))), ["unwind_round"]);
});

test("plans: expire, flip, desk only inside the auction window and when idle", () => {
  const win = t("2026-10-07T08:05:00Z"), off = t("2026-10-07T12:00:00Z");
  const only = (p: PlanState, now: number) => types(planKeeperActions(snap({ plans: [p] }), now, opts).filter((x) => x.type !== "open_epoch"));
  assert.deepEqual(only(plan(), win), ["desk_open_round"]);
  assert.deepEqual(only(plan(), off), []);
  assert.deepEqual(only(plan({ activeRound: "R" }), win), []);
  assert.deepEqual(only(plan({ pendingSettlement: "R" }), win), []);
  assert.deepEqual(only(plan({ paused: true }), win), []);
  assert.deepEqual(only(plan({ horizonEnd: win - 1 }), win), ["expire_plan"]);
  assert.deepEqual(only(plan({ horizonEnd: win - 1, activeRound: "R" }), win), []);
  assert.deepEqual(only(plan({ side: "Wheel", sizeFilled: 1_000_000_000n }), off), ["desk_flip"]);
  assert.deepEqual(only(plan({ quick: true }), win), [], "quick disabled");
  assert.deepEqual(only(plan({ status: "Filled" }), win), []);
});

test("quick plans: desk window = 90 s lead + the first 60 s of each 10-min epoch", () => {
  assert.ok(inAuctionWindow("Quick", t("2026-10-05T14:58:30Z")));
  assert.ok(inAuctionWindow("Quick", t("2026-10-05T15:00:00Z")));
  assert.ok(inAuctionWindow("Quick", t("2026-10-05T15:01:00Z")));
  assert.ok(!inAuctionWindow("Quick", t("2026-10-05T15:01:01Z")));
  assert.ok(!inAuctionWindow("Quick", t("2026-10-05T14:58:29Z")));
});

test("eligible expiries respect max_expiry_secs and horizon_end", () => {
  const now = t("2026-10-07T08:05:00Z");
  const all = eligibleExpiries({ quick: false, maxExpirySecs: 60 * 86400, horizonEnd: now + 60 * 86400 }, now);
  assert.equal(new Date(all[0]! * 1000).toISOString(), "2026-10-08T08:00:00.000Z");
  assert.ok(all.includes(t("2026-10-09T08:00:00Z")) && all.includes(t("2026-10-30T08:00:00Z")));
  const short = eligibleExpiries({ quick: false, maxExpirySecs: 3 * 86400, horizonEnd: now + 60 * 86400 }, now);
  assert.ok(short.every((e) => e <= now + 3 * 86400));
  const q = eligibleExpiries({ quick: true, maxExpirySecs: 3600, horizonEnd: now + 3600 }, t("2026-10-05T15:00:30Z"));
  assert.deepEqual(q, [t("2026-10-05T15:10:00Z")]);
});
import { quickTargetExpiry } from "../src/keeper/plan.js";
import { waitForWindowImpl } from "../src/keeper/index.js";
test("quick desk lead: desk may start 90 s early; held until the window opens; missed window is off-chain", async () => {
  const e = t("2026-10-05T15:10:00Z");
  assert.equal(quickTargetExpiry(e - 691), null);
  assert.equal(quickTargetExpiry(e - 690), e);
  assert.equal(quickTargetExpiry(e - 540), e);
  assert.equal(quickTargetExpiry(e - 539), null);
  let clock = (e - 650) * 1000;
  const sleeps: number[] = [];
  const r = await waitForWindowImpl("Quick", e, 30, () => clock, async (ms) => { sleeps.push(ms); clock += ms; });
  assert.ok(r.ok && clock === (e - 600) * 1000 && sleeps.length > 0);
  assert.equal((await waitForWindowImpl("Quick", e, 30, () => (e - 530) * 1000, async () => {})).ok, false);
  assert.equal((await waitForWindowImpl("Std", e, 60, () => t("2026-10-07T08:29:00Z") * 1000, async () => {})).ok, true);
  assert.equal((await waitForWindowImpl("Std", e, 60, () => t("2026-10-07T08:31:00Z") * 1000, async () => {})).ok, false);
  const q = eligibleExpiries({ quick: true, maxExpirySecs: 3600, horizonEnd: e + 3600 }, e - 650);
  assert.deepEqual(q, [e]);
});

// ---- data-flow fixes (6 Oct): pool window deadline, give-up, stale-feed hold ----
test("untaken auction: pool take only inside [pool_open, pool_open + 60 − margin]; then cancel; give-up → cancel", () => {
  const r = round(); // pool_open = 1090, pool deadline (permissionless cancel) = 1150
  const acts = (now: number, o: Partial<typeof opts> & { poolGaveUp?: Set<string> } = {}) =>
    planKeeperActions(snap({ rounds: [r] }), now, { ...opts, ...o }).filter((x) => x.type.includes("round"));
  assert.deepEqual(types(acts(1146)), ["pool_take_round"]);
  const late = acts(1148);
  assert.deepEqual(types(late), ["cancel_round"]);
  assert.equal((late[0] as any).reason, "pool window passed");
  const gaveUp = acts(1095, { poolGaveUp: new Set(["Round1"]) });
  assert.deepEqual(types(gaveUp), ["cancel_round"]);
  assert.equal((gaveUp[0] as any).reason, "pool take failed");
  // No pool: makers can't take after pool_open (AuctionOver), so cancelling at pool_open loses nothing.
  assert.equal((planKeeperActions(snap({ rounds: [r], pool: null }), 1090, opts)[0] as any)?.reason ?? (planKeeperActions(snap({ rounds: [r], pool: null }), 1090, opts).find((x) => x.type === "cancel_round") as any).reason, "no pool");
});

import { Keeper as KeeperExec } from "../src/keeper/index.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MemoryRepo } from "../src/db/memory.js";
test("keeper holds pool_take_round (no tx, no backoff) while the push feed is stale; gives up on a non-retryable error", async () => {
  const roundPk = Keypair.generate().publicKey.toBase58();
  const assetPk = Keypair.generate().publicKey.toBase58();
  const r = round({ pubkey: roundPk, asset: assetPk });
  let age = 590; // max 600 − margin 15 → stale
  const takes: string[] = [];
  let fail: Error | null = null;
  const chain: any = {
    programId: new PublicKey("4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe"),
    spotAgeSecs: async () => age,
    poolTakeRound: async (_kp: Keypair, pk: PublicKey) => { if (fail) throw fail; takes.push(pk.toBase58()); return "PoolSig"; },
    cancelRound: async () => "CancelSig",
  };
  const s = snap({ now: 1100, rounds: [r], assets: [{ ...snap({}).assets[0]!, pubkey: assetPk }] });
  const snapshots: any = { get: async () => s, invalidate() {}, peek: () => s };
  const k = new KeeperExec({ chain, snapshots, signer: Keypair.generate(), repo: new MemoryRepo(), desk: null, quickEnabled: false });
  await k.tick();
  assert.equal(takes.length, 0, "held while stale");
  age = 20;
  await k.tick();
  assert.deepEqual(takes, [roundPk], "taken once fresh, immediately (hold left no backoff)");
  // Non-retryable program error → the next plan cancels instead of retrying until the deadline.
  takes.length = 0;
  const e: any = new Error("failed"); e.logs = ["Program log: AnchorError Error Code: PoolCapExceeded. Error Number: 6028."]; fail = e;
  const k2 = new KeeperExec({ chain, snapshots, signer: Keypair.generate(), repo: new MemoryRepo(), desk: null, quickEnabled: false });
  await k2.tick();
  const planned = planKeeperActions(s, 1100, { ...opts, poolGaveUp: (k2 as any).poolGaveUp });
  assert.equal((planned.find((x) => x.type === "cancel_round") as any)?.reason, "pool take failed");
});

import { roundEndsBeforeWindow } from "../src/keeper/plan.js";
test("chained quick desk: a Live round expiring at the next window's open doesn't block the desk lead; later ones do", () => {
  const W = t("2026-10-05T15:00:00Z"); // window for the 15:10 epoch opens at 15:00
  const now = W - 60; // inside the 90 s lead
  const live = (expiry: number, status: RoundState["status"] = "Live") => round({ pubkey: "R", plan: "Plan1", expiry, status });
  const q = (r: RoundState, o: Partial<PlanState> = {}) =>
    types(planKeeperActions(snap({ plans: [plan({ quick: true, activeRound: "R", ...o })], rounds: [r] }), now, { ...opts, quickEnabled: true }).filter((x) => x.type === "desk_open_round"));
  assert.deepEqual(q(live(W)), ["desk_open_round"], "round in the 15:00 epoch resolves at window open");
  assert.deepEqual(q(live(W + 600)), [], "round in the targeted epoch itself");
  assert.deepEqual(q(live(W, "Auction")), [], "untaken auction still pending");
  assert.deepEqual(q(live(W), { pendingSettlement: "R" }), [], "exercise settlement pending");
  assert.ok(!roundEndsBeforeWindow({ rounds: [live(W)] }, { quick: false, activeRound: "R", pendingSettlement: null }, now), "std plans never chain");
});

import { planDemoActions } from "../src/demo/plans.js";
test("demo plans: create missing buy/sell near spot; close only idle plans whose strike drifted > 0.5 %", () => {
  const assets = [{ ...snap({}).assets[0]!, strikeTick: 100_000n }];
  const now = 1_000_000;
  const spot = 120_340_000n;
  const mine = (o: Partial<PlanState>) => plan({ owner: "Demo", quick: true, horizonEnd: now + 3600, ...o });
  const a0 = planDemoActions({ plans: [], assets }, "Demo", spot, now);
  assert.deepEqual(a0.map((a: any) => [a.type, a.side, a.strike]), [["create", "buy", 120_300_000n], ["create", "sell", 120_400_000n]]);
  const buy = mine({ pubkey: "B", side: "Buy", targetStrike: 119_500_000n });
  const sell = mine({ pubkey: "S", side: "Sell", exitStrike: 120_400_000n });
  const a1 = planDemoActions({ plans: [buy, sell], assets }, "Demo", spot, now);
  assert.deepEqual(a1.map((a) => a.type + ":" + ("plan" in a ? a.plan : "")), ["close:B"], "buy strike 0.7 % away → close; sell at spot → keep");
  assert.equal(planDemoActions({ plans: [{ ...buy, activeRound: "R" }, sell], assets }, "Demo", spot, now).length, 0, "never close a plan with a round");
  assert.deepEqual(planDemoActions({ plans: [{ ...buy, owner: "Someone" }, sell], assets }, "Demo", spot, now).map((a) => a.type), ["create"], "other owners' plans are ignored");
  assert.deepEqual(planDemoActions({ plans: [{ ...buy, status: "Filled" }, sell], assets }, "Demo", spot, now).map((a: any) => a.side), ["buy"], "filled → re-create");
});
