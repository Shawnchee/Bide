import { test } from "node:test";
import assert from "node:assert/strict";
import { createDesk, createDeskFromEnv } from "./orchestrator.js";
import { createRiskJudge } from "./risk/judge.js";
import { memoHash } from "./canonical.js";
import { EXP, NOW_MS, fakeTools, fixturePlan, reply, riskReply, scriptedTransport, toolCalls } from "./testlib.js";
import type { ChatRequest } from "./llm/chat.js";
import type { DeskStep } from "./types.js";

/** Quant step that copies premium_start/floor from the latest price_grid tool result (like the real model should). */
const proposeFromGrid = (over: Record<string, unknown> = {}) => (req: ChatRequest) => {
  const toolMsgs = req.messages.filter((m) => m.role === "tool");
  const grid = toolMsgs.map((m) => JSON.parse((m as any).content)).reverse().find((r) => Array.isArray(r?.cells));
  const cell = grid.cells.find((c: any) => c.expiry === EXP.w3) ?? grid.cells[0];
  return reply({ action: "open", strike: cell.strike, size: grid.size, expiry: cell.expiry, auction_secs: 30, premium_start: cell.premium_start, premium_floor: cell.premium_floor, rationale: `Target is ${grid.distance.user_price_vs_spot_pct}% from spot, band ${grid.distance.band.label}; floor ${cell.premium_floor_usd}.`, ...over });
};

const quantTools = [
  toolCalls(["get_plan", {}], ["get_spot", { asset: "SOL" }], ["event_calendar", {}]),
  toolCalls(["price_grid", { asset: "SOL", strikes: ["110000000"], expiries: [EXP.w2, EXP.w3], size: "1500000000" }], ["fill_probability", { asset: "SOL", strike: "110000000", expiry: EXP.w3 }], ["venue_dispersion", { asset: "SOL", expiry: EXP.w3 }]),
];

function clock() {
  let t = NOW_MS;
  return () => t++;
}

function deskWith(script: Parameters<typeof scriptedTransport>[0], calls: string[] = []) {
  const transport = scriptedTransport(script);
  const risk = createRiskJudge({ backend: "glm", glm: { transport, model: "glm-5.3" }, clef: { model: "clef", timeoutMs: 1 } });
  const desk = createDesk({ tools: fakeTools(fixturePlan(), calls), transport, risk, quantModel: "glm-5.3", now: clock() });
  return { desk, transport };
}

test("happy path: tools → Quant open → Risk approve → open, memo hashed, card rendered", async () => {
  const steps: DeskStep[] = [];
  const { desk, transport } = deskWith([...quantTools, proposeFromGrid(), riskReply({ approve: 0.86, adjust: 0.1, veto: 0.04 })]);
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "round", patience: "balanced" }, { onStep: (s) => void steps.push(s) });
  assert.equal(r.final.status, "open");
  assert.equal(r.final.proposal?.strike, "110000000");
  assert.equal(r.memo_hash.length, 32);
  assert.equal(memoHash(JSON.parse(r.memo_json)).hex, r.memo_hash_hex, "stored memo re-hashes to the same value");
  assert.deepEqual(r.memo.provenance, { strike: true, size: true, expiry: true, premium_start: true, premium_floor: true });
  assert.equal(r.memo.tool_traces.length, 6);
  assert.deepEqual(r.memo.model_ids, { quant: "glm-5.3", risk: ["glm:glm-5.3"] });
  assert.ok(steps.some((s) => s.step === "tool_call") && steps.some((s) => s.step === "risk_result") && steps.at(-1)?.step === "memo");
  assert.equal(r.card?.kind, "open");
  // Quant was offered all 9 tools; Risk request had no tools and json_object
  assert.equal(transport.requests[0]!.tools?.length, 9); // 8 + recent_outcomes (agents v2)
  assert.equal(transport.requests.at(-1)!.tools, undefined);
  // derived distance band visible to the Quant (SOL 121 → 110 = -9.09% → 2-4 weeks)
  assert.match(r.final.proposal!.rationale, /-9\.0909% from spot, band 2-4 weeks/);
});

test("memo hash is deterministic for identical runs", async () => {
  const run = async () => (await deskWith([...quantTools, proposeFromGrid(), riskReply({ approve: 0.86, adjust: 0.1, veto: 0.04 })]).desk.runDesk({ plan_id: "PLAN111", kind: "round" })).memo_hash_hex;
  assert.equal(await run(), await run());
});

test("Risk is never shown plan bounds; Quant is told the chain enforces them but not forbidden", async () => {
  const { desk, transport } = deskWith([...quantTools, proposeFromGrid(), riskReply({ approve: 0.86, adjust: 0.1, veto: 0.04 })]);
  await desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  const riskReq = JSON.stringify(transport.requests.at(-1)!.messages);
  assert.match(riskReq, /pricing_cell\\":\{/, "risk sees the matching price cell");
  for (const leak of ["strike_min", "strike_max", "min_premium_bps_per_day", "max_expiry_secs", "horizon_end", "user_min_floor"]) assert.ok(!riskReq.includes(leak), leak);
  const sys = (transport.requests[0]!.messages[0] as any).content as string;
  assert.match(sys, /rejects it on-chain/);
  assert.doesNotMatch(sys, /\b(never|must not|do not) (exceed|go outside|propose.*outside)/i);
});

test("out-of-bounds proposal is passed through untouched (program decides)", async () => {
  const { desk } = deskWith([...quantTools, proposeFromGrid({ strike: "125000000", expiry: EXP.m1 + 999 * 86400 }), riskReply({ approve: 0.9, adjust: 0.05, veto: 0.05 })]);
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  assert.equal(r.final.status, "open");
  assert.equal(r.final.proposal?.strike, "125000000");
  assert.equal(r.memo.provenance.strike, false);
});

test("adjust → one Quant retry with the top concern → approve", async () => {
  const { desk, transport } = deskWith([
    ...quantTools,
    proposeFromGrid({ size: "4500000000" }),
    riskReply({ approve: 0.2, adjust: 0.7, veto: 0.1 }, { user_fit: { matches: 0.2, too_aggressive: 0.75, too_passive: 0.05 } }),
    proposeFromGrid(),
    riskReply({ approve: 0.8, adjust: 0.15, veto: 0.05 }),
  ]);
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "round", patience: "patient" });
  assert.equal(r.final.status, "open");
  assert.equal(r.final.proposal?.size, "1500000000");
  assert.equal(r.memo.quant_proposal.length, 2);
  assert.equal(r.memo.quant_proposal[1]!.trigger, "risk_adjust");
  assert.equal(r.memo.clef_answers.length, 2);
  const retryReq = transport.requests[4]!; // [0,1] tools, [2] proposal, [3] risk, [4] retry
  assert.match(JSON.stringify(retryReq.messages.at(-1)), /too aggressive/);
});

test("adjust then veto on the retry → vetoed (no second retry)", async () => {
  const { desk } = deskWith([...quantTools, proposeFromGrid(), riskReply({ approve: 0.2, adjust: 0.7, veto: 0.1 }), proposeFromGrid(), riskReply({ approve: 0.1, adjust: 0.3, veto: 0.6 })]);
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  assert.equal(r.final.status, "vetoed");
  assert.equal(r.card?.kind, "vetoed");
});

test("veto → no open, no retry", async () => {
  const { desk, transport } = deskWith([...quantTools, proposeFromGrid(), riskReply({ approve: 0.1, adjust: 0.2, veto: 0.7 })]);
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  assert.equal(r.final.status, "vetoed");
  assert.equal(transport.requests.length, 4);
});

test("skip → no risk call", async () => {
  const { desk, transport } = deskWith([toolCalls(["event_calendar", {}]), reply({ action: "skip", strike: null, size: null, expiry: null, auction_secs: null, premium_start: null, premium_floor: null, rationale: "CPI lands the day before every candidate epoch." })]);
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  assert.equal(r.final.status, "skip");
  assert.equal(transport.requests.length, 2);
  assert.equal(r.card?.kind, "skip");
});

test("invalid Quant JSON → one repair → ok; twice invalid → error status (fail closed)", async () => {
  const ok = deskWith([...quantTools, { content: "I think we should open a round." }, proposeFromGrid(), riskReply({ approve: 0.9, adjust: 0.05, veto: 0.05 })]);
  const r1 = await ok.desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  assert.equal(r1.final.status, "open");
  assert.ok(r1.steps.some((s) => s.step === "quant_repair"));
  assert.equal(ok.transport.requests[3]!.tools, undefined, "repair turn has no tools");

  const bad = deskWith([...quantTools, { content: "nope" }, { content: '{"action":"open"}' }]);
  const r2 = await bad.desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  assert.equal(r2.final.status, "error");
  assert.match(r2.final.reason, /QUANT_OUTPUT_INVALID/);
  assert.equal(r2.memo_hash.length, 32);
});

test("tool budget exhausted → final turn without tools", async () => {
  const transport = scriptedTransport([toolCalls(["get_plan", {}]), toolCalls(["get_spot", { asset: "SOL" }]), reply({ action: "skip", rationale: "Budget used; waiting." })]);
  const risk = createRiskJudge({ backend: "glm", glm: { transport, model: "m" }, clef: { model: "clef", timeoutMs: 1 } });
  const desk = createDesk({ tools: fakeTools(), transport, risk, quantModel: "glm-5.3", maxToolRounds: 2, now: clock() });
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "preview" });
  assert.equal(r.final.status, "skip");
  assert.equal(transport.requests[2]!.tools, undefined);
});

test("missing ZAI_API_KEY → typed MISSING_SECRET error status, no network", async () => {
  const desk = createDeskFromEnv(fakeTools(), { RISK_BACKEND: "glm" });
  const r = await desk.runDesk({ plan_id: "PLAN111", kind: "preview" });
  assert.equal(r.final.status, "error");
  assert.match(r.final.reason, /MISSING_SECRET: ZAI_API_KEY is not set/);
  assert.equal(r.card?.kind, "error");
});

test("retryWithChainError feeds the on-chain error code back once", async () => {
  const { desk, transport } = deskWith([
    ...quantTools,
    proposeFromGrid({ strike: "125000000" }),
    riskReply({ approve: 0.9, adjust: 0.05, veto: 0.05 }),
    toolCalls(["get_plan", {}]),
    ...quantTools.slice(1),
    proposeFromGrid(),
    riskReply({ approve: 0.9, adjust: 0.05, veto: 0.05 }),
  ]);
  const first = await desk.runDesk({ plan_id: "PLAN111", kind: "round" });
  const second = await desk.retryWithChainError(first, "StrikeOutOfBounds");
  assert.equal(second.final.status, "open");
  assert.equal(second.final.proposal?.strike, "110000000");
  assert.equal(second.memo.inputs.chain_retry?.previous_memo_hash, first.memo_hash_hex);
  assert.equal(second.memo.quant_proposal[0]!.trigger, "chain_error");
  const retryCtx = JSON.stringify(transport.requests[4]!.messages[2]);
  assert.match(retryCtx, /StrikeOutOfBounds/);
  assert.match(retryCtx, /outside the price range the user signed/);
  assert.notEqual(second.memo_hash_hex, first.memo_hash_hex);
});
