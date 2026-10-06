import { test } from "node:test";
import assert from "node:assert/strict";
import { bindRisk, normalise } from "./risk/binding.js";
import { parseClefResponse, clefRequestBody, callClefWorkersAi } from "./risk/clef.js";
import { createRiskJudge } from "./risk/judge.js";
import { buildRiskState } from "./risk/state.js";
import { RISK_QUESTIONS } from "./risk/questions.js";
import { MissingSecretError, DeskError } from "./errors.js";
import { scriptedTransport, riskReply, NOW_MS, EXP, fixturePlan } from "./testlib.js";
import type { RiskAnswers, ToolTrace } from "./types.js";

const base: RiskAnswers = {
  verdict: { approve: 0.7, adjust: 0.2, veto: 0.1 },
  event_risk: { none: 0.7, low: 0.2, medium: 0.08, high: 0.02 },
  data_quality: { poor: 0.05, fair: 0.25, good: 0.7 },
  user_fit: { matches: 0.8, too_aggressive: 0.15, too_passive: 0.05 },
  explanation_ok: { yes: 0.9, no: 0.1 },
};

test("binding: argmax verdict; ties go to the more conservative verdict", () => {
  assert.equal(bindRisk(base).verdict, "approve");
  assert.equal(bindRisk({ ...base, verdict: { approve: 0.2, adjust: 0.3, veto: 0.5 } }).verdict, "veto");
  assert.equal(bindRisk({ ...base, verdict: { approve: 0.4, adjust: 0.4, veto: 0.2 } }).verdict, "adjust");
  assert.equal(bindRisk({ ...base, verdict: { approve: 1 / 3, adjust: 1 / 3, veto: 1 / 3 } }).verdict, "veto");
});

test("binding: top concern is the highest-probability bad option", () => {
  const b = bindRisk({ ...base, verdict: { approve: 0.2, adjust: 0.6, veto: 0.2 }, user_fit: { matches: 0.3, too_aggressive: 0.65, too_passive: 0.05 } });
  assert.equal(b.top_concern?.question, "user_fit");
  assert.equal(b.top_concern?.option, "too_aggressive");
});

test("normalise sums to 1 and rejects negatives", () => {
  const n = normalise(["a", "b"], { a: 2, b: 6 });
  assert.equal(n.a, 0.25);
  assert.throws(() => normalise(["a"], { a: -1 }));
});

test("Clef request uses the documented shape (model, state, questions keyed by id)", () => {
  const body = clefRequestBody("clef", { b: 1, a: 2 });
  assert.equal(body.model, "clef");
  assert.equal(body.state, '{"a":2,"b":1}');
  assert.deepEqual(Object.keys(body.questions).sort(), ["data_quality", "event_risk", "explanation_ok", "user_fit", "verdict"]);
  assert.equal(RISK_QUESTIONS.event_risk.type, "score");
  assert.equal(RISK_QUESTIONS.explanation_ok.type, "noul");
});

test("Clef response parser: REST envelope with choice/score/noul answers", () => {
  const body = {
    success: true,
    errors: [],
    result: {
      model: "clef",
      answers: {
        verdict: { type: "choice", choice: "approve", probabilities: { approve: 0.86, adjust: 0.1, veto: 0.04 }, confidence: 0.8 },
        event_risk: { type: "score", score: 0.4, probabilities: [0.65, 0.3, 0.04, 0.01] },
        data_quality: { type: "score", score: 1.7 },
        user_fit: { type: "choice", choice: "matches", probabilities: { matches: 0.9, too_aggressive: 0.07, too_passive: 0.03 } },
        explanation_ok: 0.93,
      },
      usage: { input_tokens: 900 },
    },
  };
  const r = parseClefResponse(body, "clef");
  assert.equal(r.answers.verdict.approve, 0.86);
  assert.equal(r.answers.event_risk.none, 0.65);
  // score-only answer (1.7 on poor/fair/good) split between fair and good
  assert.ok(Math.abs(r.answers.data_quality.good - 0.7) < 1e-9);
  assert.ok(Math.abs(r.answers.data_quality.fair - 0.3) < 1e-9);
  assert.equal(r.answers.explanation_ok.yes, 0.93);
});

test("Clef parser: real Workers AI answer shapes (captured 2026-10-06)", () => {
  const body = { success: true, errors: [], result: { model: "clef", answers: {
    verdict: { type: "choice", choice: "adjust", probabilities: { approve: 0.2486, adjust: 0.5108, veto: 0.2406 }, confidence: 0.0709 },
    event_risk: { type: "score", score: 2.0104, legend: { "0": "none", "1": "low", "2": "medium", "3": "high" }, probabilities: { "0": 0.0362, "1": 0.1239, "2": 0.6566, "3": 0.1833 } },
    data_quality: { type: "score", score: 1.5, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } },
    user_fit: { type: "choice", choice: "matches", probabilities: { matches: 0.7, too_aggressive: 0.2, too_passive: 0.1 } },
    explanation_ok: { type: "noul", noul: 0.3712 },
  } } };
  const r = parseClefResponse(body, "clef");
  assert.equal(r.answers.verdict.adjust, 0.5108);
  assert.equal(r.answers.explanation_ok.yes, 0.3712);
});

test("Clef parser fails loudly on an unexpected shape", () => {
  assert.throws(() => parseClefResponse({ result: { answers: { verdict: "approve" } } }, "clef"), (e: unknown) => e instanceof DeskError && e.code === "RISK_OUTPUT_INVALID");
});

test("workers-ai backend throws a typed MissingSecretError when CF keys are absent", async () => {
  await assert.rejects(callClefWorkersAi({ accountId: undefined, token: "x", model: "clef", state: {}, timeoutMs: 1000 }), (e: unknown) => e instanceof MissingSecretError && e.envName === "CF_ACCOUNT_ID");
});

test("judge falls back to GLM when Clef is unavailable, and records why", async () => {
  const t = scriptedTransport([riskReply({ approve: 0.8, adjust: 0.15, veto: 0.05 })]);
  const judge = createRiskJudge({ backend: "workers-ai", glm: { transport: t, model: "glm-5.3" }, clef: { model: "clef", timeoutMs: 1000 } });
  const r = await judge.judge({ x: 1 });
  assert.equal(r.backend, "glm");
  assert.equal(r.fallbacks[0]?.backend, "workers-ai");
  assert.match(r.fallbacks[0]!.error, /CF_ACCOUNT_ID/);
  assert.equal(t.requests[0]?.response_format?.type, "json_object");
});

test("GLM risk: one repair on invalid JSON, then RISK_UNAVAILABLE if still invalid", async () => {
  const ok = scriptedTransport([{ content: "{not json" }, riskReply({ approve: 0.1, adjust: 0.1, veto: 0.8 })]);
  const j1 = createRiskJudge({ backend: "glm", glm: { transport: ok, model: "m" }, clef: { model: "clef", timeoutMs: 1 } });
  assert.equal(bindRisk((await j1.judge({})).answers).verdict, "veto");
  const bad = scriptedTransport([{ content: "{}" }, { content: "{}" }]);
  const j2 = createRiskJudge({ backend: "glm", glm: { transport: bad, model: "m" }, clef: { model: "clef", timeoutMs: 1 } });
  await assert.rejects(j2.judge({}), (e: unknown) => e instanceof DeskError && e.code === "RISK_UNAVAILABLE");
});

test("risk state never contains plan bounds", () => {
  const plan = fixturePlan({ strike_min: "104000000", strike_max: "110000000", min_premium_bps_per_day: 17, max_expiry_secs: 1234567, horizon_end: 1799999999 });
  const traces: ToolTrace[] = [
    { call_id: "1", name: "get_plan", args: {}, ok: true, result: { ...plan, derived: { user_price: plan.target_strike } }, started_at: 0, duration_ms: 0, attempt: 0 },
    { call_id: "2", name: "price_grid", args: {}, ok: true, result: { size: "1500000000", spot: "121000000", cells: [{ strike: "110000000", expiry: EXP.w3, fair_premium: "7000000", bid_premium: "6000000", premium_start: "9100000", premium_floor: "5400000", user_min_floor: "4700000", floor_over_user_min: 1.15 }] }, started_at: 0, duration_ms: 0, attempt: 0 },
  ];
  const state = buildRiskState({
    proposal: { action: "open", strike: "110000000", size: "1500000000", expiry: EXP.w3, auction_secs: 30, premium_start: "9100000", premium_floor: "5400000", rationale: "r" },
    traces, asset: "SOL", asset_decimals: 9, round_kind: "put", patience: "balanced", now_ms: NOW_MS,
  });
  const s = JSON.stringify(state);
  for (const leak of ["strike_min", "strike_max", "min_premium_bps_per_day", "max_expiry_secs", "horizon_end", "1799999999", "1234567", "104000000", "user_min_floor", "floor_over_user_min", "size_total", "max_rounds"]) {
    assert.ok(!s.includes(leak), `risk state leaks ${leak}`);
  }
  assert.ok(s.includes("CPI") || s.includes("FOMC"), "events before expiry included");
  assert.equal((state as any).market.pricing_cell.premium_floor, "5400000");
});
