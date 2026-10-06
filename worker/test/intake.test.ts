// Intake agent: shape schema, code-side validation (unsafe → null + question), 202-and-poll service, HTTP auth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIntake, intakeOutputSchema, intakeSystemPrompt, IntakeService, MAX_TEXT } from "../src/agents/intake.js";
import { MemoryRepo } from "../src/db/memory.js";
import { scriptedTransport, reply } from "../src/desk/testlib.js";

const NOW = Date.parse("2026-10-06T06:00:00Z") / 1000;
const ctx = { spotUsd: 120, nowSecs: NOW, quickEnabled: true };
const v = (fields: Record<string, unknown>, extra: { assumptions?: string[]; questions?: string[] } = {}) =>
  validateIntake(intakeOutputSchema.parse({ fields, ...extra }), ctx);

test("intake schema: shape only (fields object + string lists)", () => {
  assert.ok(intakeOutputSchema.safeParse({ fields: {}, assumptions: [], questions: [] }).success);
  assert.ok(intakeOutputSchema.safeParse({ fields: { goal: "buy" } }).success, "lists default to []");
  assert.ok(!intakeOutputSchema.safeParse({ assumptions: [] }).success);
  assert.ok(!intakeOutputSchema.safeParse({ fields: {}, questions: "what?" }).success);
});

test("intake: a complete buy goal passes through", () => {
  const r = v({ goal: "buy", asset: "SOL", quick: false, target_price_usd: 110, amount: 500, amount_unit: "USDC", horizon: "1m", min_pay: "standard", patience: null }, { assumptions: ["I assumed 1 month."] });
  assert.deepEqual(r.fields, { goal: "buy", asset: "SOL", quick: false, target_price_usd: 110, exit_price_usd: null, amount: 500, amount_unit: "USDC", horizon: "1m", deadline_date: null, min_pay: "standard", patience: null });
  assert.deepEqual(r.assumptions, ["I assumed 1 month."]);
  assert.deepEqual(r.questions, []);
});

test("intake: unsafe or unknown values are left empty with a question", () => {
  const above = v({ goal: "buy", target_price_usd: 130 });
  assert.equal(above.fields.target_price_usd, null);
  assert.match(above.questions[0]!, /above today's price/);
  assert.equal(v({ goal: "sell", target_price_usd: 100 }).fields.target_price_usd, null, "sell below spot");
  assert.equal(v({ goal: "buy", target_price_usd: 5 }).fields.target_price_usd, null, "absurd price (< 0.4 × spot)");
  assert.equal(v({ goal: "buy", target_price_usd: "$110" }).fields.target_price_usd, 110, "dollar string accepted");
  const btc = v({ asset: "BTC" });
  assert.equal(btc.fields.asset, null);
  assert.match(btc.questions[0]!, /Only SOL/);
  const wrongUnit = v({ goal: "buy", amount: 2, amount_unit: "SOL" });
  assert.equal(wrongUnit.fields.amount, null);
  assert.match(wrongUnit.questions[0]!, /USDC/);
  assert.equal(v({ goal: "sell", amount: 5000, amount_unit: "SOL" }).fields.amount, null, "over the demo cap");
  assert.equal(v({ goal: "buy", amount: -3, amount_unit: "USDC" }).fields.amount, null);
  assert.equal(v({ goal: "weird" }).fields.goal, null);
  assert.equal(v({ min_pay: "max" }).fields.min_pay, null);
  assert.equal(v({ horizon: "forever" }).fields.horizon, null);
});

test("intake: exit price only for buy-then-sell and above both prices", () => {
  assert.equal(v({ goal: "both", target_price_usd: 110, exit_price_usd: 140 }).fields.exit_price_usd, 140);
  assert.equal(v({ goal: "both", target_price_usd: 110, exit_price_usd: 115 }).fields.exit_price_usd, null, "below spot");
  assert.equal(v({ goal: "buy", target_price_usd: 110, exit_price_usd: 140 }).fields.exit_price_usd, null);
});

test("intake: horizon / quick / deadline consistency", () => {
  const q = v({ horizon: "q1h" });
  assert.equal(q.fields.quick, true);
  assert.equal(q.fields.horizon, "q1h");
  assert.match(q.assumptions.join(" "), /quick/);
  assert.equal(v({ quick: false, horizon: "q1h" }).fields.horizon, null);
  assert.equal(v({ quick: true, horizon: "3m" }).fields.horizon, null);
  const d = v({ horizon: "date", deadline_date: "2026-11-20" });
  assert.equal(d.fields.horizon, "date");
  assert.equal(d.fields.deadline_date, "2026-11-20");
  assert.equal(v({ deadline_date: "2027-12-01" }).fields.deadline_date, null, "> 6 months");
  assert.equal(v({ horizon: "date" }).fields.horizon, null, "date without a date");
  assert.equal(validateIntake({ fields: { horizon: "q1h" }, assumptions: [], questions: [] }, { ...ctx, quickEnabled: false }).fields.horizon, null);
});

test("intake prompt: no base units, asks for questions instead of computing", () => {
  const p = intakeSystemPrompt({ spotUsd: 120, nowIso: "2026-10-06T06:00:00Z", quickEnabled: true });
  assert.match(p, /never invent a price/);
  assert.match(p, /do not compute/);
  assert.match(p, /\$120\.00/);
});

test("IntakeService: 202-style start, poll result, model failure → error status, rate limit, length cap", async () => {
  const repo = new MemoryRepo();
  const transport = scriptedTransport([
    reply({ fields: { goal: "buy", target_price_usd: 110, amount: 200, amount_unit: "USDC" }, assumptions: ["I assumed 1 month."], questions: [] }),
    reply("not json"),
    reply("still not json"),
  ]);
  const svc = new IntakeService({ repo, transport, model: "glm-5.3", timeoutMs: 5_000, maxPerMinute: 2, spot: () => 120, now: () => NOW * 1000 });
  const a = await svc.start("buy $200 of SOL at 110 within a month");
  assert.equal((await svc.get(a.id))!.status, "running");
  await a.done;
  const ra = (await svc.get(a.id))!;
  assert.equal(ra.status, "done");
  assert.equal((ra.fields as any).target_price_usd, 110);
  assert.equal(transport.requests[0]!.messages[1]!.content, "buy $200 of SOL at 110 within a month");
  const b = await svc.start("gibberish");
  await b.done;
  const rb = (await svc.get(b.id))!;
  assert.equal(rb.status, "error");
  assert.ok(rb.error && !/json/i.test(rb.error), "user-facing error, not internals");
  await assert.rejects(svc.start("third within a minute"), /too many requests/);
  await assert.rejects(new IntakeService({ repo, transport, model: "m", timeoutMs: 1, maxPerMinute: 9, spot: () => null }).start("x".repeat(MAX_TEXT + 1)), /longer than/);
  assert.equal(await svc.get("nope"), null);
});

test("HTTP /intake: shared secret required; 202 then poll", async () => {
  const { cfg } = await import("../src/config.js");
  const { buildApp } = await import("../src/http/server.js");
  const saved = cfg.workerSharedSecret;
  (cfg as any).workerSharedSecret = "test-secret";
  try {
    const repo = new MemoryRepo();
    const intake = new IntakeService({ repo, transport: scriptedTransport([reply({ fields: { goal: "sell" }, assumptions: [], questions: ["What price?"] })]), model: "m", timeoutMs: 5_000, maxPerMinute: 5, spot: () => 120 });
    const app = buildApp({ pricer: {} as any, repo, desk: null, deskTools: {} as any, intake, loopStats: () => [], status: () => ({}) });
    const unauth = await app.request("/intake", { method: "POST", body: JSON.stringify({ text: "sell" }), headers: { "content-type": "application/json" } });
    assert.equal(unauth.status, 401);
    const res = await app.request("/intake", { method: "POST", body: JSON.stringify({ text: "sell my SOL" }), headers: { "content-type": "application/json", authorization: "Bearer test-secret" } });
    assert.equal(res.status, 202);
    const { intake_id } = (await res.json()) as { intake_id: string };
    let body: any;
    for (let i = 0; i < 50; i++) {
      body = await (await app.request(`/intake/${intake_id}`, { headers: { authorization: "Bearer test-secret" } })).json();
      if (body.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(body.status, "done");
    assert.deepEqual(body.questions, ["What price?"]);
    assert.equal((await app.request("/intake/x", {})).status, 401);
    const off = buildApp({ pricer: {} as any, repo, desk: null, deskTools: {} as any, intake: null, loopStats: () => [], status: () => ({}) });
    assert.equal((await off.request("/intake", { method: "POST", body: "{}", headers: { authorization: "Bearer test-secret" } })).status, 503);
  } finally {
    (cfg as any).workerSharedSecret = saved;
  }
});
