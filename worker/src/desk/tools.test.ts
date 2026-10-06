import { test } from "node:test";
import assert from "node:assert/strict";
import { Toolbox, TOOL_DEFS, distanceBand } from "./tools.js";
import { userMinPremiumFloor, notional, usd, formatUnits } from "./units.js";
import { loadEventCalendar } from "./events.js";
import { EXP, NOW_MS, fakeTools, fixturePlan } from "./testlib.js";

test("tool definitions: 9 tools with JSON-schema parameters", () => {
  assert.deepEqual(TOOL_DEFS.map((t) => t.function.name).sort(), ["event_calendar", "fill_probability", "get_plan", "get_spot", "lend_apy", "price_grid", "recent_outcomes", "spot_moves", "venue_dispersion"]);
  for (const t of TOOL_DEFS) assert.equal((t.function.parameters as any).type, "object");
});

test("units: notional rounding, user-minimum floor matches the open_round inequality", () => {
  assert.equal(notional("110000000", "1500000000", 9), 165_000_000n);
  assert.equal(notional("110000001", "1", 9, "up"), 1n);
  const floor = userMinPremiumFloor({ notional: 100_000_000n, minBpsPerDay: 10, secsToExpiry: 864_000, feeBps: 1000 });
  assert.equal(floor, 1_111_112n);
  // program check: floor × (10000 − fee) / 10000 ≥ notional × bps × secs / (86400 × 10000)
  const lhs = (floor * 9000n) / 10_000n, rhs = (100_000_000n * 10n * 864_000n) / (86_400n * 10_000n);
  assert.ok(lhs >= rhs);
  assert.equal(usd(1_234_567_890n), "$1,234.56");
  assert.equal(formatUnits("4550000000", 9, 4), "4.55");
});

test("distance bands per SPEC §6", () => {
  assert.equal(distanceBand(-2.5, false).label, "1-2 days");
  assert.equal(distanceBand(5, false).label, "about 1 week");
  assert.equal(distanceBand(-9.1, false).label, "2-4 weeks");
  assert.equal(distanceBand(-20, true).label, "quick (10 min)");
});

test("toolbox enriches get_plan / price_grid and traces every call, incl. failures", async () => {
  const tb = new Toolbox({ tools: fakeTools(), planId: "PLAN111", now: () => NOW_MS });
  await tb.call("get_spot", { asset: "SOL" });
  const plan: any = (await tb.call("get_plan", {})).result;
  assert.equal(plan.derived.round_kind, "put");
  assert.deepEqual(plan.derived.ladder_size_options, { all_remaining: "4500000000", half: "2250000000", third: "1500000000" });
  assert.equal(plan.derived.distance.band.label, "2-4 weeks");
  assert.equal(plan.derived.epochs_matching_plan_kind.length, 5, "epochs are NOT filtered by plan bounds");
  const grid: any = (await tb.call("price_grid", { asset: "SOL", strikes: ["110000000"], expiries: [EXP.w3], size: "1500000000" })).result;
  assert.equal(grid.cells[0].notional, "165000000");
  assert.ok(typeof grid.cells[0].floor_over_user_min === "number");
  const bad = await tb.call("nope", {});
  assert.equal(bad.ok, false);
  assert.equal(tb.traces.length, 4);
  assert.equal(tb.traces[3]!.ok, false);
  // plan is fixture; a quick plan sees only quick epochs
  const qb = new Toolbox({ tools: fakeTools(fixturePlan({ quick: true })), planId: "P", now: () => NOW_MS });
  assert.equal(((await qb.call("get_plan", {})).result as any).derived.epochs_matching_plan_kind.length, 0);
});

test("event calendar: static file, sorted, every event has an official source", () => {
  const cal = loadEventCalendar();
  assert.ok(cal.events.length >= 6);
  for (let i = 1; i < cal.events.length; i++) assert.ok(cal.events[i]!.at_unix >= cal.events[i - 1]!.at_unix);
  for (const e of cal.events) assert.match(e.source, /^https:\/\/www\.(federalreserve|bls)\.gov\//);
});

test("quick plans only see epochs whose auction window is still open (desk starts up to 90 s early)", async () => {
  const E = Date.parse("2026-10-06T05:40:00Z") / 1000; // at 05:38:30 the 05:40 epoch's window (05:30–05:31) is gone
  const now = (E - 90) * 1000;
  const plan = fixturePlan({ quick: true, open_epochs: [{ expiry: E, kind: "quick" }, { expiry: E + 600, kind: "quick" }, { expiry: E + 1200, kind: "quick" }] });
  const tb = new Toolbox({ tools: fakeTools(plan), planId: "P", now: () => now });
  const ep = ((await tb.call("get_plan", {})).result as any).derived.epochs_matching_plan_kind.map((e: any) => e.expiry);
  assert.deepEqual(ep, [E + 600], "only the 05:50 epoch: 05:40's window closed, 06:00's opens in 10 min");
  // std: < 12 h to expiry is not openable
  const sp = fixturePlan({ open_epochs: [{ expiry: E + 3600, kind: "std" }, { expiry: E + 86_400, kind: "std" }] });
  const sb = new Toolbox({ tools: fakeTools(sp), planId: "P", now: () => now });
  assert.deepEqual(((await sb.call("get_plan", {})).result as any).derived.epochs_matching_plan_kind.map((e: any) => e.expiry), [E + 86_400]);
});

// ---- agents v2: recent_outcomes (deterministic; Risk never sees it) ----
import { buildRiskState } from "./risk/state.js";
import { citesRecentOutcomes } from "./orchestrator.js";

test("recent_outcomes: served by DeskTools when implemented, honest note when not; scoped to the run's plan", async () => {
  const none = new Toolbox({ tools: fakeTools(), planId: "PLAN111", now: () => NOW_MS });
  const r0 = await none.call("recent_outcomes", {});
  assert.equal(r0.ok, true);
  assert.match(JSON.stringify(r0.result), /no outcome history/);
  const seen: unknown[] = [];
  const tools = { ...fakeTools(), recent_outcomes: async (a: { plan_id: string; asset: string; limit: number }) => { seen.push(a); return { plan: { n_rounds: 3, fill_rate: 0.6667 }, asset: { n_rounds: 9 }, guidance: { may_inform: [], never_changes: [], caveat: "" } }; } };
  const tb = new Toolbox({ tools, planId: "PLAN111", now: () => NOW_MS });
  const r = await tb.call("recent_outcomes", { limit: 500 });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ plan_id: "PLAN111", asset: "SOL", limit: 50 }]);
});

test("Risk state never includes recent_outcomes data", async () => {
  const tools = { ...fakeTools(), recent_outcomes: async () => ({ plan: { fill_rate: 0.123456, marker: "OUTCOMES_MARKER" }, asset: null, guidance: { may_inform: [], never_changes: [], caveat: "" } }) };
  const tb = new Toolbox({ tools, planId: "PLAN111", now: () => NOW_MS });
  await tb.call("get_plan", {});
  await tb.call("recent_outcomes", {});
  const state = buildRiskState({
    proposal: { action: "open", strike: "110000000", size: "1500000000", expiry: EXP.w2, auction_secs: 300, premium_start: "1", premium_floor: "1", rationale: "r" },
    traces: tb.traces, asset: "SOL", asset_decimals: 9, round_kind: "put", patience: null, now_ms: NOW_MS,
  });
  assert.doesNotMatch(JSON.stringify(state), /OUTCOMES_MARKER|0\.123456|recent_outcomes/);
});

test("citesRecentOutcomes: number from the tool, 'no past rounds', or not cited", () => {
  const traces = [{ name: "recent_outcomes", ok: true, result: { plan: { fill_rate: 0.6667, seconds_to_fill: { median: 7.5, n: 4 } } } }];
  assert.equal(citesRecentOutcomes("Past rounds filled in a median 7.5 s, so 30 s auctions suffice.", traces), true);
  assert.equal(citesRecentOutcomes("There are no past rounds for this plan yet.", traces), true);
  assert.equal(citesRecentOutcomes("recent_outcomes shows 0 past rounds for this plan and asset, so there is no track record.", traces), true, "live phrasing 2026-10-06");
  assert.equal(citesRecentOutcomes("CPI risk; skipping.", traces), false);
  assert.equal(citesRecentOutcomes("anything", []), null);
});
