import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeribit } from "../src/pricer/venues/deribit.js";
import { parseOkx } from "../src/pricer/venues/okx.js";
import { parseBybit } from "../src/pricer/venues/bybit.js";
import { parseBinance } from "../src/pricer/venues/binance.js";
import { parseDdMmmYy, parseYyMmDd } from "../src/pricer/venues/common.js";
import { fixture, FIXTURE_NOW } from "./helpers.js";
import type { Quote } from "../src/pricer/types.js";

const all = {
  deribit: parseDeribit("SOL", fixture("deribit_usdc_option.json"), FIXTURE_NOW),
  okx: parseOkx("SOL", fixture("okx_sol.json"), FIXTURE_NOW),
  bybit: parseBybit("SOL", fixture("bybit_sol.json"), FIXTURE_NOW),
  binance: parseBinance("SOL", fixture("binance_mark.json"), fixture("binance_index_sol.json"), FIXTURE_NOW),
};

test("date parsers give 08:00 UTC", () => {
  assert.equal(new Date(parseDdMmmYy("9OCT26")!).toISOString(), "2026-10-09T08:00:00.000Z");
  assert.equal(new Date(parseYyMmDd("261030")!).toISOString(), "2026-10-30T08:00:00.000Z");
  assert.equal(parseDdMmmYy("9FOO26"), undefined);
});

for (const [venue, qs] of Object.entries(all) as [string, Quote[]][]) {
  test(`${venue}: parses every SOL instrument with sane units`, () => {
    assert.ok(qs.length > 50, `${venue} parsed ${qs.length}`);
    for (const q of qs) {
      assert.equal(new Date(q.expiry).getUTCHours(), 8);
      assert.ok(q.strike > 1 && q.strike < 2000);
      assert.ok(q.forward > 50 && q.forward < 500);
      for (const iv of [q.bidIv, q.askIv, q.markIv]) if (iv !== undefined) assert.ok(iv > 0.01 && iv < 10, `${q.instrument} iv ${iv} must be decimal`);
    }
    assert.ok(qs.some((q) => q.bidIv !== undefined), "some bids");
  });
}

test("deribit: mark_iv percent → decimal; implied bid IV ≤ ask IV", () => {
  const raw = fixture("deribit_usdc_option.json").result.find((r: any) => r.bid_price > 0 && r.ask_price > 0);
  const q = all.deribit.find((x) => x.instrument === raw.instrument_name)!;
  assert.ok(Math.abs(q.markIv! - raw.mark_iv / 100) < 1e-12);
  assert.ok(q.bidIv! <= q.askIv!);
  assert.ok(Math.abs(q.markIv! - (q.bidIv! + q.askIv!) / 2) < 0.15, "mark within the bid/ask IV range-ish");
});
test("binance: tiny bidIV / askIV=-1 is treated as no quote", () => {
  const q = all.binance.find((x) => x.instrument === "SOL-261030-84-C")!;
  assert.equal(q.bidIv, undefined);
  assert.equal(q.askIv, undefined);
});
test("okx/bybit: \"0\" IV is treated as no quote", () => {
  const rawOkx = fixture("okx_sol.json").data.find((r: any) => r.bidVol === "0");
  assert.equal(all.okx.find((x) => x.instrument === rawOkx.instId)!.bidIv, undefined);
  const rawBy = fixture("bybit_sol.json").result.list.find((r: any) => r.bid1Iv === "0");
  assert.equal(all.bybit.find((x) => x.instrument === rawBy.symbol)!.bidIv, undefined);
});
