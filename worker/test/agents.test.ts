// AI agents v2: maker stances (schema, clamp, grounding, fallback, independence), outcome stats, P&L, queue, repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stanceSchema, bidFromStance, decideStance, assertIndependent, type StanceContext } from "../src/agents/maker/stance.js";
import { PERSONAS, personaFor, stanceSystemPrompt } from "../src/agents/maker/personas.js";
import { checkThesis, thesisNumbers } from "../src/agents/grounding.js";
import { MakerAgents, stanceTargets, stanceKey } from "../src/agents/maker/service.js";
import { decideBotBid } from "../src/makers/index.js";
import { outcomeStats, secondsToFill, makerPnl } from "../src/agents/outcomes.js";
import { roundOutcomes } from "../src/loops/mirror.js";
import { LlmQueue } from "../src/agents/queue.js";
import { MemoryRepo } from "../src/db/memory.js";
import { readAgentConfig } from "../src/agents/config.js";
import { extractJsonObject } from "../src/agents/json.js";
import { scriptedTransport, reply, fakeTools } from "../src/desk/testlib.js";
import type { ChainSnapshot, EpochState, PlanState, RoundState, AssetState } from "../src/chain/types.js";
import type { MakerStanceRow, RoundRow } from "../src/db/types.js";

const NOW = 1_791_300_000; // unix secs (fixture)

function ctx(over: Partial<StanceContext> = {}): StanceContext {
  return {
    maker: "maker-2", asset: "SOL", round_kind: "put",
    epoch: { expiry: NOW + 600, expiry_utc: new Date((NOW + 600) * 1000).toISOString(), kind: "quick", days_to_expiry: 0.007 },
    now_utc: new Date(NOW * 1000).toISOString(),
    spot: { price_usd: 121.4, age_secs: 3 },
    spot_moves: { move_1h_pct: -0.42, move_24h_pct: -2.15, move_7d_pct: 3.1 },
    price_grid: [{ strike_usd: 119, strike_vs_spot_pct: -1.98, fair_usd: 0.0312, bid_usd: 0.0251, fair_iv: 0.4812, fill_probability: 0.084, venues: 3 }],
    venue_dispersion: { venues_used: 3, iv_spread_vol_pts: 1.8 },
    events: [{ name: "US CPI (September 2026)", kind: "cpi", at_utc: "2026-10-14T12:30:00Z", inside_option_life: false }],
    my_inventory: { usdc: 812.5, asset: 4.2, open_notional_usdc: 0, max_open_notional_usdc: 200 },
    my_history: { rounds_won: 0, settled: 0, cumulative_pnl_usd: 0, last: [] },
    ...over,
  };
}
const persona = personaFor("maker-2")!;

// ---------------- schema ----------------
test("stance schema: accepts the four fields, rejects base units / out-of-range / extra keys", () => {
  assert.ok(stanceSchema.safeParse({ stance: "bid", spread_pct: 6.5, thesis: "x", confidence: 0.6 }).success);
  assert.ok(stanceSchema.safeParse({ stance: "pass", spread_pct: 0, thesis: "x", confidence: 0.2 }).success);
  assert.ok(!stanceSchema.safeParse({ stance: "bid", spread_pct: 25, thesis: "x", confidence: 0.6 }).success, "spread > 20");
  assert.ok(!stanceSchema.safeParse({ stance: "bid", spread_pct: -1, thesis: "x", confidence: 0.6 }).success);
  assert.ok(!stanceSchema.safeParse({ stance: "bid", spread_pct: 5, thesis: "x".repeat(281), confidence: 0.6 }).success, "thesis > 280");
  assert.ok(!stanceSchema.safeParse({ stance: "bid", spread_pct: 5, thesis: "x", confidence: 1.2 }).success);
  assert.ok(!stanceSchema.safeParse({ stance: "bid", spread_pct: 5, thesis: "x", confidence: 0.5, bid_usdc_base_units: "520000" }).success, "LLM never emits base units");
});

test("personas: two distinct makers; prompt forbids invented numbers and unlisted events, never mentions desk inputs", () => {
  assert.deepEqual(PERSONAS.map((p) => p.maker), ["maker-1", "maker-2"]);
  for (const p of PERSONAS) {
    const s = stanceSystemPrompt(p);
    assert.match(s, /spread_pct/);
    assert.match(s, /copied from the input JSON/);
    assert.match(s, /do not see the seller's desk/);
    assert.doesNotMatch(s, /base units/i);
  }
});

// ---------------- clamp ----------------
test("bidFromStance: bid = fair × (1 − spread), clamped to [floor, min(start, fair)]; pass → no bid", () => {
  assert.deepEqual(bidFromStance("bid", 10, 100_000n, 50_000n, 130_000n), { bid: 90_000n, note: null });
  assert.deepEqual(bidFromStance("bid", 20, 100_000n, 95_000n, 130_000n), { bid: 95_000n, note: "raised to the auction floor" });
  assert.deepEqual(bidFromStance("bid", 0, 100_000n, 50_000n, 80_000n), { bid: 80_000n, note: "capped at the auction start" });
  assert.deepEqual(bidFromStance("bid", 0, 100_000n, 50_000n, 130_000n), { bid: 100_000n, note: null }, "spread 0 = fair (inside the range)");
  assert.equal(bidFromStance("pass", 5, 100_000n, 50_000n, 130_000n).bid, null);
  assert.deepEqual(bidFromStance("bid", 5, 40_000n, 50_000n, 130_000n), { bid: null, note: "fair below the auction floor" });
  assert.equal(bidFromStance("bid", 99, 100_000n, 10_000n, 130_000n).bid, 80_000n, "spread is capped at 20% in code too");
});

// ---------------- grounding ----------------
test("grounding: numbers must come from the inputs (rounding and % variants allowed); events must be in the calendar", () => {
  const c = ctx();
  assert.deepEqual(thesisNumbers("paid $1,234.50 at 3%"), ["1234.5", "3"]);
  assert.ok(checkThesis("SOL fell 2.15% in 24h and P(fill) is 8.4%; 3 venues agree within 1.8 vol pts.", c, ["cpi"]).grounded);
  assert.ok(checkThesis("Fair $0.03 vs spot $121.4.", c, ["cpi"]).grounded, "rounded value of 0.0312");
  const bad = checkThesis("SOL fell 9% today.", c, ["cpi"]);
  assert.equal(bad.grounded, false);
  assert.deepEqual(bad.unknownNumbers, ["9"]);
  const ev = checkThesis("FOMC risk inside the window.", c, ["cpi"]);
  assert.equal(ev.grounded, false);
  assert.deepEqual(ev.unknownEvents, ["FOMC"]);
  assert.ok(checkThesis("CPI lands after expiry.", c, ["cpi"]).grounded);
  assert.equal(checkThesis("ETF flows look strong.", c, ["cpi", "fomc"]).grounded, false, "events outside events.json are never citable");
});

// ---------------- decideStance ----------------
test("decideStance: grounded valid reply → llm stance", async () => {
  const t = scriptedTransport([reply({ stance: "bid", spread_pct: 4, thesis: "Down 2.15% in 24h: I want the protection, bid near fair.", confidence: 0.7 })]);
  const d = await decideStance({ transport: t, model: "glm-5.3", persona, ctx: ctx(), timeoutMs: 5_000 });
  assert.equal(d.source, "llm");
  assert.equal(d.stance, "bid");
  assert.equal(d.spread_pct, 4);
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0]!.messages[0]!.role, "system");
});

test("decideStance: fenced JSON is accepted; one repair turn; still invalid → fallback", async () => {
  const ok = await decideStance({ transport: scriptedTransport([reply("```json\n{\"stance\":\"pass\",\"spread_pct\":0,\"thesis\":\"Rally of 3.1% over 7d.\",\"confidence\":0.5}\n```")]), model: "m", persona, ctx: ctx(), timeoutMs: 5_000 });
  assert.equal(ok.source, "llm");
  const repaired = await decideStance({ transport: scriptedTransport([reply({ stance: "bid", spread_pct: 30, thesis: "x", confidence: 1 }), reply({ stance: "bid", spread_pct: 12, thesis: "Quiet window.", confidence: 0.4 })]), model: "m", persona, ctx: ctx(), timeoutMs: 5_000 });
  assert.equal(repaired.source, "llm");
  assert.equal(repaired.spread_pct, 12);
  const t = scriptedTransport([reply("no idea"), reply("still prose")]);
  const fb = await decideStance({ transport: t, model: "m", persona, ctx: ctx(), timeoutMs: 5_000 });
  assert.equal(fb.source, "fallback");
  assert.match(fb.fallback_reason!, /invalid after one repair/);
  assert.equal(t.requests.length, 2);
});

test("decideStance: ungrounded thesis → fallback flagged ungrounded (thesis kept for audit)", async () => {
  const d = await decideStance({ transport: scriptedTransport([reply({ stance: "bid", spread_pct: 3, thesis: "SOL dumped 12% and FOMC is tomorrow.", confidence: 0.9 })]), model: "m", persona, ctx: ctx(), timeoutMs: 5_000 });
  assert.equal(d.source, "fallback");
  assert.equal(d.grounded, false);
  assert.match(d.fallback_reason!, /ungrounded thesis/);
  assert.match(d.fallback_reason!, /12/);
  assert.match(d.fallback_reason!, /FOMC/);
  assert.ok(d.thesis);
});

test("decideStance: timeout and transport errors → fallback", async () => {
  const slow = { provider: "t", complete: () => new Promise<never>(() => {}) };
  const d = await decideStance({ transport: slow, model: "m", persona, ctx: ctx(), timeoutMs: 30 });
  assert.equal(d.source, "fallback");
  assert.match(d.fallback_reason!, /timed out/);
  const err = { provider: "t", complete: async () => { throw new Error("Z.ai HTTP 429"); } };
  assert.match((await decideStance({ transport: err, model: "m", persona, ctx: ctx(), timeoutMs: 1_000 })).fallback_reason!, /429/);
});

test("independence: a context carrying desk / plan-bound fields is refused before any model call", async () => {
  assert.doesNotThrow(() => assertIndependent(ctx()));
  const leaky = { ...ctx(), proposal: { strike: "1" } } as unknown as StanceContext;
  assert.throws(() => assertIndependent(leaky), /proposal/);
  const t = scriptedTransport([]);
  const d = await decideStance({ transport: t, model: "m", persona, ctx: leaky, timeoutMs: 1_000 });
  assert.equal(d.source, "fallback");
  assert.equal(t.requests.length, 0);
});

// ---------------- bot bid from stance / fallback ----------------
const round = { premiumStart: 130_000n, premiumFloor: 70_000n, auctionStart: NOW, auctionSecs: 30 };
const readyStance = (over: Partial<MakerStanceRow> = {}) => ({
  status: "ready" as const,
  row: { id: "st-1", stance_key: "k", asset: "A", epoch_pubkey: "E", expiry: "", kind: "put" as const, maker: "maker-2", persona: "Momentum desk", source: "llm" as const, model: "glm-5.3", stance: "bid" as const, spread_pct: 10, thesis: "t", confidence: 0.6, grounded: true, fallback_reason: null, context: null, stance_hash: "h", latency_ms: 1, ...over },
});
const fb = { bid: 95_000n, spread: 0.05 };

test("decideBotBid: LLM stance → derived bid; pass → no bid", () => {
  const d = decideBotBid({ round, nowSecs: NOW + 1, fair: 100_000n, fallback: fb, stance: readyStance(), llmEnabled: true, volTilt: 0.02 })!;
  assert.equal(d.source, "llm");
  assert.equal(d.bid, 90_000n);
  assert.equal(d.stanceId, "st-1");
  const p = decideBotBid({ round, nowSecs: NOW + 1, fair: 100_000n, fallback: fb, stance: readyStance({ stance: "pass" }), llmEnabled: true, volTilt: 0.02 })!;
  assert.equal(p.bid, null);
  assert.equal(p.stance, "pass");
});

test("decideBotBid: pending stance waits for the grace period, then falls back (source=fallback, reason kept)", () => {
  assert.equal(decideBotBid({ round, nowSecs: NOW + 5, fair: 100_000n, fallback: fb, stance: { status: "pending" }, llmEnabled: true, volTilt: 0.02 }), null);
  const d = decideBotBid({ round, nowSecs: NOW + 16, fair: 100_000n, fallback: fb, stance: { status: "pending" }, llmEnabled: true, volTilt: 0.02 })!;
  assert.equal(d.source, "fallback");
  assert.equal(d.bid, 95_000n);
  assert.equal(d.reason, "stance still pending at round open");
  assert.equal(d.spreadPct, 5);
  const failed = decideBotBid({ round, nowSecs: NOW + 1, fair: 100_000n, fallback: fb, stance: readyStance({ source: "fallback", stance: null, fallback_reason: "ungrounded thesis (x)" }), llmEnabled: true, volTilt: -0.02 })!;
  assert.equal(failed.source, "fallback");
  assert.equal(failed.stanceId, "st-1");
  assert.match(failed.reason!, /ungrounded/);
  const off = decideBotBid({ round, nowSecs: NOW, fair: 100_000n, fallback: fb, stance: undefined, llmEnabled: false, volTilt: -0.02 })!;
  assert.equal(off.reason, "MAKER_LLM off");
  assert.match(off.thesis!, /Deterministic fallback/);
});

// ---------------- stance targets (per asset, epoch) ----------------
const asset: AssetState = { pubkey: "ASSET", mint: "So11111111111111111111111111111111111111112", decimals: 9, pythFeedId: "", strikeTick: 100_000n, maxConfBps: 0, maxSpotMoveBps: 0, maxSpotAgeSecs: 60, enabled: true, symbol: "SOL" };
const plan = (over: Partial<PlanState> = {}): PlanState => ({
  pubkey: "PLAN", owner: "O", asset: "ASSET", side: "Buy", phase: "Accumulate", quick: true, targetStrike: 0n, exitStrike: 0n, strikeMin: 0n, strikeMax: 0n, callStrikeMin: 0n,
  callStrikeMax: 0n, lockStrike: true, sizeTotal: 0n, sizeFilled: 0n, collateralPrincipal: 0n, lendShares: 0n, pendingSettlement: null, minPremiumBpsPerDay: 0, maxExpirySecs: 0,
  horizonEnd: 0, maxRoundsPerDay: 0, roundsToday: 0, dayIndex: 0, roundCount: 0, activeRound: null, paused: false, status: "Active", ...over,
});
const epoch = (expiry: number, kind: "Std" | "Quick", pubkey = `EP${expiry}`): EpochState => ({ pubkey, asset: "ASSET", kind, expiry, nBuckets: 0, bucketSecs: 0, bucketToleranceSecs: 0, samples: [], sampleMask: 0, settlePrice: 0n, status: "Open" });
const snap = (now: number, plans: PlanState[], epochs: EpochState[], rounds: RoundState[] = []): ChainSnapshot => ({ now, config: { admin: "", agent: "", paused: false, feeBps: 1000, feeRecipient: "" }, assets: [asset], plans, rounds, epochs, pool: null });

test("stanceTargets: quick epoch is due from window−lead to window close; only kinds with an active plan", () => {
  const E = 1_791_300_600; // multiple of 600
  const s = (now: number, plans = [plan()]) => stanceTargets(snap(now, plans, [epoch(E, "Quick")]), 240);
  assert.equal(s(E - 600 - 241).length, 0, "too early");
  assert.deepEqual(s(E - 600 - 240).map((t) => t.kind), ["put"]);
  assert.equal(s(E - 540).length, 1);
  assert.equal(s(E - 539).length, 0, "window closed");
  assert.equal(s(E - 600, [plan({ paused: true })]).length, 0, "paused plans don't count");
  assert.deepEqual(s(E - 600, [plan({ side: "Sell" })]).map((t) => t.kind), ["call"]);
  assert.deepEqual(s(E - 600, [plan(), plan({ side: "Wheel", phase: "Exit" })]).map((t) => t.kind).sort(), ["call", "put"]);
});

test("stanceTargets: std epochs are due around the 08:00 UTC window if ≥ 12 h to expiry", () => {
  const day = Math.floor(NOW / 86_400) * 86_400;
  const w = day + 86_400 + 28_800; // tomorrow 08:00
  const eps = [epoch(w + 86_400, "Std"), epoch(w + 3_600, "Std"), epoch(w + 7 * 86_400, "Std")];
  const t = (now: number) => stanceTargets(snap(now, [plan({ quick: false })], eps), 240).map((x) => x.epoch.expiry).sort();
  assert.deepEqual(t(w - 300), []);
  assert.deepEqual(t(w - 200), [w + 86_400, w + 7 * 86_400], "epoch < 12 h from the window is excluded");
  assert.deepEqual(t(w + 1_799).length, 2);
  assert.deepEqual(t(w + 1_800), []);
});

test("MakerAgents: one stance per (maker, epoch, kind); context is public-only; quota guard → fallback", async () => {
  const repo = new MemoryRepo();
  const E = 1_791_300_600;
  const tools = fakeTools();
  const replyOk = reply({ stance: "bid", spread_pct: 5, thesis: "Spot 121 with 3 venues; quiet window.", confidence: 0.55 });
  const transport = scriptedTransport([replyOk, replyOk, replyOk]);
  const agents = new MakerAgents({
    repo, transport, model: "glm-5.3", cfg: { makerTimeoutMs: 5_000, stanceLeadSecs: 240, makerMaxCallsPerHour: 2 }, tools,
    makers: [{ name: "maker-1", pubkey: "M1" }, { name: "maker-2", pubkey: "M2" }],
    inventory: async () => ({ usdc: 500_000_000n, asset: 2_000_000_000n, openNotional: 0n, maxOpenNotional: 200_000_000n }),
    now: () => (E - 700) * 1000,
  });
  const s = snap(E - 700, [plan()], [epoch(E, "Quick", "EPQ")]);
  agents.tick(s);
  agents.tick(s); // idempotent while pending
  for (let i = 0; i < 50 && repo.stances.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(repo.stances.length, 2);
  assert.equal(transport.requests.length, 2);
  for (const st of repo.stances) {
    assert.equal(st.stance_key, stanceKey("ASSET", "EPQ", "put"));
    assert.equal(st.source, "llm");
    assert.match(st.stance_hash, /^[0-9a-f]{64}$/);
    assert.doesNotThrow(() => assertIndependent(st.context));
    const c = st.context as StanceContext;
    assert.equal(c.price_grid.length, 2);
    assert.ok(c.price_grid[0]!.strike_usd < 121, "put reference strikes below spot");
  }
  // A round in that epoch reuses the stored stance (no new call).
  const r = { pubkey: "R", asset: "ASSET", epoch: "EPQ", kind: "Put" } as RoundState;
  assert.equal(agents.lookup(r, "maker-1", s)?.status, "ready");
  // Third epoch → quota (2/h) exhausted → fallback stance without a model call.
  const s2 = snap(E - 700, [plan()], [epoch(E, "Quick", "EPQ2")]);
  agents.lookup({ ...r, epoch: "EPQ2" }, "maker-1", s2);
  for (let i = 0; i < 50 && repo.stances.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(repo.stances[2]!.source, "fallback");
  assert.match(repo.stances[2]!.fallback_reason!, /quota guard/);
  assert.equal(transport.requests.length, 2);
});

// ---------------- outcomes + P&L ----------------
const row = (over: Partial<RoundRow>): RoundRow => ({
  round_pubkey: "R", plan_pubkey: "P", kind: "Put", strike: "119000000", size: "100000000", notional: "11900000", expiry: "", auction_start: "2026-10-06T00:00:00Z",
  premium_start: "100000", premium_floor: "40000", premium_paid: "0", fee_paid: "0", maker: null, is_pool: false, status: "Cancelled", settle_price: null, exercised: 0,
  memo_hash: "", asset: "ASSET", auction_secs: 30, ...over,
});

test("secondsToFill inverts the linear auction", () => {
  assert.equal(secondsToFill(row({ premium_paid: "100000" })), 0);
  assert.equal(secondsToFill(row({ premium_paid: "70000" })), 15);
  assert.equal(secondsToFill(row({ premium_paid: "40000" })), 30);
  assert.equal(secondsToFill(row({ premium_paid: "40000", is_pool: true })), null);
});

test("outcomeStats: fill rate, fill/start, seconds to fill, untaken, exercise rate, maker wins", () => {
  const rows = [
    row({ round_pubkey: "a", status: "Auction" }),
    row({ round_pubkey: "b", status: "Settled", premium_paid: "70000", maker: "M1", exercised: 2 }),
    row({ round_pubkey: "c", status: "Resolved", premium_paid: "100000", maker: "M2", exercised: 0 }),
    row({ round_pubkey: "d", status: "Live", premium_paid: "40000", is_pool: true, maker: "pool" }),
    row({ round_pubkey: "e", status: "Cancelled" }),
  ];
  const s = outcomeStats(rows, { M1: "maker-1", M2: "maker-2" });
  assert.equal(s.n_rounds, 5);
  assert.equal(s.auctions_finished, 4);
  assert.equal(s.taken, 3);
  assert.equal(s.fill_rate, 0.75);
  assert.equal(s.untaken, 1);
  assert.equal(s.pool_takes, 1);
  assert.deepEqual(s.fill_price_over_start, { mean: 0.7, min: 0.4, max: 1 });
  assert.deepEqual(s.seconds_to_fill, { median: 7.5, n: 2 });
  assert.equal(s.resolved, 2);
  assert.equal(s.exercise_rate, 0.5);
  assert.deepEqual(s.maker_wins, { "maker-1": 1, "maker-2": 1, pool: 1 });
  assert.equal(s.last_rounds[0]!.status, "Auction");
  assert.equal(outcomeStats([]).fill_rate, null);
});

test("makerPnl: holder value at settlement − premium paid (losses included)", () => {
  const base = { kind: "Put", strike: 119_000_000n, size: 100_000_000n, premiumPaid: 70_000n };
  assert.equal(makerPnl({ ...base, settlePrice: 118_000_000n, exercised: true }, 9), 100_000n - 70_000n);
  assert.equal(makerPnl({ ...base, settlePrice: 0n, exercised: false }, 9), -70_000n);
  assert.equal(makerPnl({ ...base, kind: "Call", settlePrice: 121_000_000n, exercised: true }, 9), 200_000n - 70_000n);
});

test("roundOutcomes: Live→Resolved and vanished Live on a Resolved epoch; pool rounds excluded", () => {
  const live = { pubkey: "R1", asset: "ASSET", epoch: "EP", kind: "Put", status: "Live", maker: "M1", makerIsPool: false, exercised: 0, settlePrice: 0n } as unknown as RoundState;
  const prev = snap(NOW, [], [epoch(NOW + 10, "Quick", "EP")], [live, { ...live, pubkey: "R2" }, { ...live, pubkey: "R3", makerIsPool: true }]);
  const next = snap(NOW + 20, [], [{ ...epoch(NOW + 10, "Quick", "EP"), status: "Resolved", settlePrice: 118_000_000n }], [{ ...live, status: "Resolved", exercised: 2, settlePrice: 118_000_000n }]);
  const o = roundOutcomes(prev, next);
  assert.deepEqual(o.map((x) => [x.round.pubkey, x.exercised]), [["R1", true], ["R2", false]]);
  assert.equal(roundOutcomes(null, next).length, 0);
});

// ---------------- queue ----------------
test("LlmQueue: serial, lower priority number first, FIFO within a priority", async () => {
  const q = new LlmQueue();
  const order: string[] = [];
  let running = 0, maxRunning = 0;
  const job = (name: string) => async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 5)); order.push(name); running--; return name; };
  const ps = [q.enqueue(2, job("maker-a")), q.enqueue(2, job("maker-b")), q.enqueue(0, job("desk")), q.enqueue(1, job("intake"))];
  await Promise.all(ps);
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ["maker-a", "desk", "intake", "maker-b"], "first job already running; then by priority");
  await assert.rejects(q.enqueue(0, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await q.enqueue(0, async () => "after-error"), "after-error");
});

// ---------------- repo (memory backend; Supabase mirrors the same interface) ----------------
test("MemoryRepo: maker bid ledger took + P&L only on the taken row; rounds scoped by plan and asset", async () => {
  const repo = new MemoryRepo();
  const bid = { round_pubkey: "R", plan_pubkey: "P", stance_id: null, source: "llm" as const, stance: "bid" as const, spread_pct: 5, fair_at_bid: "100", bid: "95", thesis: "t", confidence: 0.5, reason: null, bid_hash: "h", took: false, tx_sig: null, pnl_usdc: null };
  await repo.insertMakerBid({ ...bid, maker: "maker-1", maker_pubkey: "M1" });
  await repo.insertMakerBid({ ...bid, maker: "maker-2", maker_pubkey: "M2" });
  await repo.markMakerBidTook("R", "maker-2", "SIG");
  await repo.setMakerBidPnl("R", "M2", "-95");
  await repo.setMakerBidPnl("R", "M1", "123"); // not taken → ignored
  const all = await repo.listMakerBids({ round: "R" });
  assert.deepEqual(all.map((b) => [b.maker, b.took, b.pnl_usdc]).sort(), [["maker-1", false, null], ["maker-2", true, "-95"]]);
  assert.equal((await repo.listMakerBids({ maker: "maker-2", took: true })).length, 1);
  await repo.upsertRounds([row({ round_pubkey: "x", plan_pubkey: "P1", auction_start: "2026-10-06T01:00:00Z" }), row({ round_pubkey: "y", plan_pubkey: "P2", asset: "OTHER" })]);
  assert.deepEqual((await repo.listRounds({ plan: "P1" })).map((r) => r.round_pubkey), ["x"]);
  assert.deepEqual((await repo.listRounds({ asset: "ASSET" })).map((r) => r.round_pubkey), ["x"]);
});

test("agent config: MAKER_LLM defaults on with a Z.ai key, off without; MAKER_LLM=0 forces off", () => {
  assert.equal(readAgentConfig({ ZAI_API_KEY: "k" }).makerLlm, true);
  assert.equal(readAgentConfig({}).makerLlm, false);
  assert.equal(readAgentConfig({ ZAI_API_KEY: "k", MAKER_LLM: "0" }).makerLlm, false);
  assert.equal(readAgentConfig({ MAKER_LLM: "1" }).makerLlm, false, "no key → never on");
});

test("extractJsonObject tolerates prose around the object", () => {
  assert.deepEqual(extractJsonObject('Here you go: {"a":1} thanks'), { a: 1 });
  assert.throws(() => extractJsonObject("nothing"));
});
