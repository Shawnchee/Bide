import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuantProposal } from "./schema.js";

const open = { action: "open", strike: "110000000", size: "1500000000", expiry: 1792742400, auction_secs: 30, premium_start: "9000000", premium_floor: "5600000", rationale: "Target is 9% below spot, so a 2-3 week epoch." };

test("valid open proposal parses; numbers become u64 strings", () => {
  const r = parseQuantProposal(JSON.stringify({ ...open, strike: 110000000 }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.strike, "110000000");
});

test("tolerates code fences and leading prose", () => {
  const r = parseQuantProposal("Here you go:\n```json\n" + JSON.stringify(open) + "\n```");
  assert.ok(r.ok);
});

test("open requires every numeric field", () => {
  const r = parseQuantProposal(JSON.stringify({ ...open, premium_floor: null }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /premium_floor/);
});

test("decimals / negatives / u64 overflow are rejected (base units only)", () => {
  for (const bad of ["110.5", "-1", "18446744073709551616", "1e8"]) {
    const r = parseQuantProposal(JSON.stringify({ ...open, strike: bad }));
    assert.equal(r.ok, false, bad);
  }
});

test("schema does NOT enforce plan bounds: absurd-but-typed values pass (chain decides)", () => {
  const r = parseQuantProposal(JSON.stringify({ ...open, strike: "999000000", premium_start: "1", premium_floor: "100000000" }));
  assert.ok(r.ok);
});

test("skip nulls the numbers; unknown keys rejected", () => {
  const s = parseQuantProposal(JSON.stringify({ action: "skip", strike: "1", rationale: "CPI tomorrow" }));
  assert.ok(s.ok);
  if (s.ok) assert.equal(s.value.strike, null);
  assert.equal(parseQuantProposal(JSON.stringify({ ...open, extra: 1 })).ok, false);
  assert.equal(parseQuantProposal("not json").ok, false);
});
