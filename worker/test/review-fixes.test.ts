// Regression tests for z_review.md W-H1, W-H2, W-L7, W-M1, W-M2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Makers, takeFailureScope } from "../src/makers/index.js";
import { Pricer } from "../src/pricer/index.js";
import { exercisedAtSettle, roundOutcomes, transitions, Mirror } from "../src/loops/mirror.js";
import { makerPnl } from "../src/agents/outcomes.js";
import { MemoryRepo } from "../src/db/memory.js";
import { parsePythParsed } from "../src/pyth/hermes.js";
import { fixture } from "./helpers.js";
import type { ChainSnapshot, RoundState } from "../src/chain/types.js";

// ---------------- W-H1: pricer spot staleness ----------------
test("W-H1: quote() rejects when the Pyth spot publishTime is older than the max age", async () => {
  const spot = parsePythParsed(fixture("hermes_sol_latest.json").parsed[0]);
  const pubMs = spot.publishTime * 1000;
  let now = pubMs + 10_000;
  const p = new Pricer(["SOL"], () => now);
  p.seed("SOL", { refreshedAt: now, spot, snapshots: [] });
  // Fresh spot: fails later for venue reasons (no snapshots), not for staleness.
  const fresh = await p.quote("SOL", "put", 100, now + 86_400_000, 1, false);
  assert.equal(fresh.ok, false);
  assert.doesNotMatch((fresh as any).reason, /stale/);
  now = pubMs + 60_000;
  p.seed("SOL", { refreshedAt: now, spot, snapshots: [] }); // venues "fresh", spot 60 s old
  const stale = await p.quote("SOL", "put", 100, now + 86_400_000, 1, false);
  assert.equal(stale.ok, false);
  assert.match((stale as any).reason, /Pyth spot stale \(60 s old\)/);
  const saved = process.env.PRICER_MAX_SPOT_AGE_SECS;
  process.env.PRICER_MAX_SPOT_AGE_SECS = "90";
  try {
    const tuned = await p.quote("SOL", "put", 100, now + 86_400_000, 1, false);
    assert.doesNotMatch((tuned as any).reason, /stale/, "env-tunable");
  } finally {
    if (saved === undefined) delete process.env.PRICER_MAX_SPOT_AGE_SECS; else process.env.PRICER_MAX_SPOT_AGE_SECS = saved;
  }
});

// ---------------- W-H2 / W-L7: makers ----------------
const WSOL = "So11111111111111111111111111111111111111112";
function makersHarness(opts: { quote: () => any; take: (kp: Keypair) => Promise<string> }) {
  const nowS = Math.floor(Date.now() / 1000);
  const roundKey = Keypair.generate().publicKey.toBase58();
  const round: RoundState = {
    pubkey: roundKey, plan: "P", asset: "ASSET", kind: "Put", strike: 200_000_000n, size: 1_000_000_000n, notional: 1n, epoch: "E", expiry: nowS + 7 * 86_400,
    auctionStart: nowS - 10, auctionSecs: 300, poolDelaySecs: 60, rentPayer: "K", premiumStart: 130_000n, premiumFloor: 70_000n, spotAtOpen: 0n,
    maker: null, makerIsPool: false, premiumPaid: 0n, feePaid: 0n, exercised: 0, settlePrice: 0n, memoHash: "", status: "Auction",
  };
  const snap = {
    now: nowS, config: {} as any, plans: [], pool: null, epochs: [{ pubkey: "E", kind: "Std" }] as any,
    assets: [{ pubkey: "ASSET", mint: WSOL, decimals: 9, symbol: "SOL", maxSpotAgeSecs: 60 }] as any, rounds: [round],
  } as ChainSnapshot;
  let quotes = 0;
  const takes: string[] = [];
  const bots = [{ name: "maker-1", kp: Keypair.generate() }, { name: "maker-2", kp: Keypair.generate() }];
  const chain = {
    tokenBalance: async () => 10n ** 15n,
    takeRound: async (kp: Keypair, _r: PublicKey) => { takes.push(bots.find((b) => b.kp === kp)!.name); return opts.take(kp); },
  };
  const pricer = { quote: async () => { quotes++; return opts.quote(); } };
  const m = new Makers(chain as any, { get: async () => snap, invalidate: () => {} } as any, pricer as any, bots, new PublicKey(WSOL), { unpricedRetryMs: 0 });
  return { m, takes, quotes: () => quotes };
}
const okQuote = { ok: true, fairPremium: 100_000_000, fairIv: 0.5, spot: 100 };

test("W-H2: an unpriced round is retried on later ticks, then bots bid once pricing recovers", async () => {
  let fail = true;
  const h = makersHarness({ quote: () => (fail ? { ok: false, reason: "venues down" } : okQuote), take: async () => "SIG" });
  await h.m.tick();
  await h.m.tick();
  assert.equal(h.quotes(), 2, "failed pricing re-attempted, not cached forever");
  assert.equal(h.takes.length, 0);
  fail = false;
  await h.m.tick();
  assert.equal(h.quotes(), 3);
  assert.equal(h.takes.length, 1, "bot takes once priced");
  await h.m.tick();
  assert.equal(h.quotes(), 3, "priced view is cached");
});

test("W-H2: failure TTL throttles re-pricing", async () => {
  const h = makersHarness({ quote: () => ({ ok: false, reason: "no Pyth spot" }), take: async () => "SIG" });
  (h.m as any).unpricedRetryMs = 60_000;
  await h.m.tick();
  await h.m.tick();
  assert.equal(h.quotes(), 1, "within the failure TTL: no re-quote");
});

const programErr = (name: string, n: number) => Object.assign(new Error("Simulation failed"), { logs: [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${n}. Error Message: x.`] });

test("W-L7: a non-terminal rejection stands down only that bot; others still take", async () => {
  let n = 0;
  const h = makersHarness({ quote: () => okQuote, take: async () => { if (n++ === 0) throw programErr("SpotMovedTooMuch", 6020); return "SIG"; } });
  await h.m.tick();
  await h.m.tick();
  assert.equal(h.takes.length, 2);
  assert.notEqual(h.takes[0], h.takes[1], "second attempt comes from the other bot");
  await h.m.tick();
  assert.equal(h.takes.length, 2, "success ends the round");
});

test("W-L7: a terminal rejection (AuctionOver) stands every bot down", async () => {
  const h = makersHarness({ quote: () => okQuote, take: async () => { throw programErr("AuctionOver", 6010); } });
  await h.m.tick();
  await h.m.tick();
  assert.equal(h.takes.length, 1);
});

test("W-L7: takeFailureScope", () => {
  assert.equal(takeFailureScope({ retryable: true }), "retry");
  assert.equal(takeFailureScope({ name: "StalePrice", retryable: false }), "retry");
  assert.equal(takeFailureScope({ name: "AuctionOver", retryable: false }), "round");
  assert.equal(takeFailureScope({ name: "WrongStatus", retryable: false }), "round");
  assert.equal(takeFailureScope({ name: "SpotMovedTooMuch", retryable: false }), "bot");
  assert.equal(takeFailureScope({ retryable: false }), "bot");
});

// ---------------- W-M1: vanished Live round on a Resolved epoch ----------------
const baseRound = (o: Partial<RoundState>): RoundState => ({
  pubkey: "R", plan: "P", asset: "A", kind: "Put", strike: 119_000_000n, size: 100_000_000n, notional: 11_900_000n, epoch: "E", expiry: 0,
  auctionStart: 0, auctionSecs: 30, poolDelaySecs: 10, rentPayer: "K", premiumStart: 1n, premiumFloor: 1n, spotAtOpen: 0n, maker: "M1", makerIsPool: false,
  premiumPaid: 70_000n, feePaid: 0n, exercised: 0, settlePrice: 0n, memoHash: "", status: "Live", ...o,
});
const snapWith = (rounds: RoundState[], epochStatus: string, settle: bigint): ChainSnapshot => ({
  now: 0, config: {} as any, plans: [], pool: null, assets: [{ pubkey: "A", decimals: 9 }] as any, rounds,
  epochs: [{ pubkey: "E", asset: "A", kind: "Quick", expiry: 0, samples: [], sampleMask: 0, status: epochStatus, settlePrice: settle } as any],
});

test("W-M1: exercisedAtSettle matches resolve_round (put iff S < K, call iff S > K)", () => {
  assert.equal(exercisedAtSettle("Put", 119n, 118n), true);
  assert.equal(exercisedAtSettle("Put", 119n, 119n), false);
  assert.equal(exercisedAtSettle("Put", 119n, 120n), false);
  assert.equal(exercisedAtSettle("Call", 119n, 120n), true);
  assert.equal(exercisedAtSettle("Call", 119n, 119n), false);
  assert.equal(exercisedAtSettle("Call", 119n, 118n), false);
  assert.equal(exercisedAtSettle("Put", 119n, 0n), false, "no settle price → not exercised");
});

test("W-M1: ITM put that vanishes between mirror ticks is recorded exercised with positive maker P&L", () => {
  const put = baseRound({ pubkey: "RP" }), call = baseRound({ pubkey: "RC", kind: "Call", strike: 117_000_000n }), otm = baseRound({ pubkey: "RO", strike: 117_000_000n });
  const prev = snapWith([put, call, otm], "Live", 0n);
  const next = snapWith([], "Resolved", 118_000_000n);
  const o = roundOutcomes(prev, next);
  assert.deepEqual(o.map((x) => [x.round.pubkey, x.exercised]), [["RP", true], ["RC", true], ["RO", false]]);
  const pnl = (x: (typeof o)[number]) => makerPnl({ ...x.round, settlePrice: x.settlePrice, exercised: x.exercised }, x.assetDecimals);
  assert.equal(pnl(o[0]!), 100_000n - 70_000n, "put: (119 − 118) × 0.1 − premium");
  assert.equal(pnl(o[1]!), 100_000n - 70_000n, "call: (118 − 117) × 0.1 − premium");
  assert.equal(pnl(o[2]!), -70_000n, "OTM: premium lost");
  const ev = transitions(prev, next).filter((e) => e.type === "RoundResolved") as any[];
  assert.deepEqual(ev.map((e) => [e.round, e.exercised]), [["RP", true], ["RC", true], ["RO", false]]);
});

test("W-M1: Mirror writes the derived exercise + settle price on the closed round row", async () => {
  const repo = new MemoryRepo();
  let s = snapWith([baseRound({ pubkey: "RP" })], "Live", 0n);
  const outcomes: boolean[] = [];
  const mirror = new Mirror({ get: async () => s } as any, repo, async (o) => { outcomes.push(o.exercised); });
  await mirror.tick();
  s = snapWith([], "Resolved", 118_000_000n);
  await mirror.tick();
  const row = (repo as any).rounds.get("RP");
  assert.equal(row.status, "Resolved");
  assert.equal(row.exercised, 2);
  assert.equal(row.settle_price, "118000000");
  assert.deepEqual(outcomes, [true]);
});

// ---------------- W-M2: /desk/runs/:id requires the shared secret ----------------
test("W-M2: GET /desk/runs/:id requires the shared secret", async () => {
  const { cfg } = await import("../src/config.js");
  const { buildApp } = await import("../src/http/server.js");
  const saved = cfg.workerSharedSecret;
  (cfg as any).workerSharedSecret = "test-secret";
  try {
    const repo = new MemoryRepo();
    const id = await repo.createDeskRun({ plan_pubkey: "P" } as any);
    const app = buildApp({ pricer: {} as any, repo, desk: null, deskTools: {} as any, intake: null, loopStats: () => [], status: () => ({}) });
    assert.equal((await app.request(`/desk/runs/${id}`)).status, 401);
    assert.equal((await app.request(`/desk/runs/${id}`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const ok = await app.request(`/desk/runs/${id}`, { headers: { authorization: "Bearer test-secret" } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).id, id);
  } finally {
    (cfg as any).workerSharedSecret = saved;
  }
});
