import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/keeper/schedule.js";

const t = (iso: string) => Date.parse(iso) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();

test("constants match BUILD §3.2 exactly", () => {
  assert.equal(S.STD_EXPIRY_SECS_OF_DAY, 28_800);
  assert.equal(S.STD_AUCTION_WINDOW_SECS, 1_800);
  assert.equal(S.STD_MIN_SECS_TO_EXPIRY, 43_200);
  assert.equal(S.QUICK_PERIOD_SECS, 600);
  assert.deepEqual([S.QUICK_AUCTION_OPEN_OFFSET, S.QUICK_AUCTION_CLOSE_OFFSET], [600, 540]);
  assert.deepEqual([S.KIND_PARAMS.Std.nBuckets, S.KIND_PARAMS.Std.bucketSecs, S.KIND_PARAMS.Std.graceSecs], [10, 180, 3600]);
  assert.deepEqual([S.KIND_PARAMS.Quick.nBuckets, S.KIND_PARAMS.Quick.bucketSecs, S.KIND_PARAMS.Quick.bucketToleranceSecs, S.KIND_PARAMS.Quick.graceSecs], [10, 10, 2, 120]);
  assert.equal(S.MAX_EPOCH_AHEAD_SECS, 180 * 86400);
});

test("next expiries", () => {
  const now = t("2026-10-05T15:00:00Z"); // Monday
  assert.equal(iso(S.nextDailyExpiry(now)), "2026-10-06T08:00:00.000Z");
  assert.equal(iso(S.nextDailyExpiry(t("2026-10-06T07:59:59Z"))), "2026-10-06T08:00:00.000Z");
  assert.equal(iso(S.nextDailyExpiry(t("2026-10-06T08:00:00Z"))), "2026-10-07T08:00:00.000Z");
  assert.equal(iso(S.nextFridayExpiry(now)), "2026-10-09T08:00:00.000Z");
  assert.equal(iso(S.nextFridayExpiry(t("2026-10-09T08:00:00Z"))), "2026-10-16T08:00:00.000Z");
  assert.equal(iso(S.nextMonthlyExpiry(now)), "2026-10-30T08:00:00.000Z");
  assert.equal(iso(S.nextMonthlyExpiry(t("2026-10-30T09:00:00Z"))), "2026-11-27T08:00:00.000Z");
  assert.equal(iso(S.nextQuickExpiry(t("2026-10-05T15:03:20Z"))), "2026-10-05T15:10:00.000Z");
  assert.equal(iso(S.nextQuickExpiry(t("2026-10-05T15:10:00Z"))), "2026-10-05T15:20:00.000Z");
});

test("open_epoch schedule check", () => {
  const now = t("2026-10-05T15:00:00Z");
  assert.ok(S.isValidEpochExpiry("Std", t("2026-10-09T08:00:00Z"), now));
  assert.ok(!S.isValidEpochExpiry("Std", t("2026-10-09T09:00:00Z"), now));
  assert.ok(S.isValidEpochExpiry("Quick", t("2026-10-05T15:10:00Z"), now));
  assert.ok(!S.isValidEpochExpiry("Quick", t("2026-10-05T15:05:00Z"), now));
  assert.ok(!S.isValidEpochExpiry("Std", now - (now % 86400) + 28800 + 181 * 86400, now));
  for (const e of S.stdEpochTargets(now)) assert.ok(S.isValidEpochExpiry("Std", e, now), iso(e));
  for (const e of S.quickEpochTargets(now)) assert.ok(S.isValidEpochExpiry("Quick", e, now), iso(e));
});

test("std auction window: 08:00:00–08:29:59 UTC, ≥12 h to expiry, before sampling window", () => {
  const fri = t("2026-10-09T08:00:00Z");
  assert.ok(S.canOpenRound("Std", fri, t("2026-10-07T08:00:00Z"), 60).ok);
  assert.ok(S.canOpenRound("Std", fri, t("2026-10-07T08:29:59Z"), 60).ok);
  assert.ok(!S.canOpenRound("Std", fri, t("2026-10-07T08:30:00Z"), 60).ok);
  assert.ok(!S.canOpenRound("Std", fri, t("2026-10-07T07:59:59Z"), 60).ok);
  // daily expiry opened at its own 08:00 window = 0 h away → rejected; next day's = 24 h → ok
  const d = t("2026-10-07T08:00:00Z");
  assert.ok(!S.canOpenRound("Std", d, t("2026-10-07T08:05:00Z"), 60).ok);
  assert.ok(S.canOpenRound("Std", d + 86400, t("2026-10-07T08:05:00Z"), 60).ok);
  assert.ok(S.stdWindowOpen(t("2026-10-07T08:10:00Z")) && !S.stdWindowOpen(t("2026-10-07T12:00:00Z")));
});

test("quick auction window: [expiry−600, expiry−540]", () => {
  const e = t("2026-10-05T15:10:00Z");
  assert.ok(S.canOpenRound("Quick", e, e - 600, 30).ok);
  assert.ok(S.canOpenRound("Quick", e, e - 540, 30).ok);
  assert.ok(!S.canOpenRound("Quick", e, e - 539, 30).ok);
  assert.ok(!S.canOpenRound("Quick", e, e - 601, 30).ok);
});

test("buckets: window start, due buckets, mask", () => {
  const e = t("2026-10-09T08:00:00Z");
  assert.equal(S.windowStart("Std", e), e - 1800);
  assert.equal(S.bucketStart("Std", e, 3), e - 1800 + 540);
  assert.deepEqual(S.dueBuckets("Std", e, 0, e - 1800 - 1), []);
  assert.deepEqual(S.dueBuckets("Std", e, 0, e - 1800), [0]);
  assert.deepEqual(S.dueBuckets("Std", e, 0b0000000101, e - 1800 + 400), [1]);
  assert.deepEqual(S.dueBuckets("Quick", e, 0, e), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(S.dueBuckets("Quick", e, 0, e + 121), [], "nothing after grace");
});

test("resolve_epoch outcome mirror", () => {
  const e = 1_000_000;
  assert.equal(S.resolveAction("Std", e, 10, e - 1), "wait");
  assert.equal(S.resolveAction("Std", e, 10, e), "resolve");
  assert.equal(S.resolveAction("Std", e, 9, e + 100), "wait", "partial waits for grace");
  assert.equal(S.resolveAction("Std", e, 8, e + 3600), "resolve");
  assert.equal(S.resolveAction("Std", e, 7, e + 3600), "fail");
  assert.equal(S.resolveAction("Quick", e, 7, e + 120), "fail");
  assert.equal(S.popcount(0b1011), 3);
});

test("default auction secs: std 300 s, quick 30 s; both inside the kind range and before the sampling window", () => {
  assert.equal(S.DEFAULT_AUCTION_SECS.Std, 300);
  assert.equal(S.DEFAULT_AUCTION_SECS.Quick, 30);
  for (const k of ["Std", "Quick"] as const) {
    const p = S.KIND_PARAMS[k];
    assert.ok(S.DEFAULT_AUCTION_SECS[k] >= p.auctionSecsMin && S.DEFAULT_AUCTION_SECS[k] <= p.auctionSecsMax, k);
  }
  // Worst case std: opened at 08:29:59 for the nearest legal expiry (next day 08:00) — now + 300 + 60 < window_start.
  const now = t("2026-10-07T08:29:59Z"), next = t("2026-10-08T08:00:00Z");
  assert.ok(now + S.DEFAULT_AUCTION_SECS.Std + S.KIND_PARAMS.Std.poolDelaySecs < S.windowStart("Std", next));
  assert.ok(S.canOpenRound("Std", next, now, S.DEFAULT_AUCTION_SECS.Std).ok);
  // Worst case quick: opened at expiry − 540 with 30 s + 10 s pool delay still before the 100 s sampling window.
  const e = t("2026-10-07T08:10:00Z");
  assert.ok(e - 540 + S.DEFAULT_AUCTION_SECS.Quick + S.KIND_PARAMS.Quick.poolDelaySecs < S.windowStart("Quick", e));
});
