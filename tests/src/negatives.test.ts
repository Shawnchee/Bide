// Every bound the program enforces (BUILD §8 Phase 1 negatives). Each test asserts the exact Bide error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  ata, epochPda, minPremiumFloor, notionalFloor, nextStdExpiry, windowStart, PYTH_FEED_IDS, USDC_MINT, WSOL_MINT,
} from "@bide/shared";
import { setupWorld, shiftPushFeed, SOL_FEED, World } from "./fixtures.js";
import { cloneSample, createQuickBuyPlan, fundMaker, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

async function ready(opts: { size?: bigint; planExtra?: Record<string, unknown> } = {}) {
  const w = await setupWorld();
  fundMaker(w, w.maker);
  const spot = realSpotUsdc(w);
  const strike = (spot / 1_000_000n - 3n) * 1_000_000n;
  const size = opts.size ?? 200_000_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, size, 1, opts.planExtra ?? {});
  return { w, strike, size, epoch, expiry, plan };
}

async function takeIt(w: World, round: any) {
  const { env } = w;
  const r = env.decode<any>("round", round);
  const p = env.decode<any>("plan", r.plan);
  return env.client.takeRound(w.maker.publicKey, round, r, p, env.decode<any>("asset", w.asset), w.feeRecipient.publicKey);
}

test("open_round bounds: strike, tick, size, premium min, start clamp, auction secs, unauthorized", async () => {
  const { w, strike, size, epoch, expiry, plan } = await ready();
  const { env, agent } = w;
  const ag = [agent];
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike: strike + 1_000_000n, size })).ix], ag, "StrikeOutOfBounds");
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike: strike - 50_000n, size })).ix], ag, "StrikeOffTick");
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size: size + 1n })).ix], ag, "SizeTooLarge");
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size, floor: 1n, start: 2n })).ix], ag, "PremiumBelowUserMin");
  const notional = notionalFloor(strike, size, 9);
  const okFloor = minPremiumFloor(1000, notional, 10, expiry - env.now()) + 100n;
  // exact boundary: the minimum floor passes the user-min check, one less fails
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size, floor: okFloor - 101n, start: okFloor })).ix], ag, "PremiumBelowUserMin");
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size, floor: okFloor, start: okFloor * 3n + 1n })).ix], ag, "AuctionParamsInvalid");
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size, floor: okFloor, start: okFloor - 1n })).ix], ag, "AuctionParamsInvalid");
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size, auctionSecs: 500 })).ix], ag, "AuctionParamsInvalid");
  // a non-agent signer
  const evil = env.newWallet(5);
  const p = env.decode<any>("plan", plan);
  const ix = await env.client.openRound(evil.publicKey, plan, p, env.decode<any>("asset", w.asset), epoch, {
    strike, size, auctionSecs: 30, premiumStart: okFloor * 2n, premiumFloor: okFloor, memoHash: new Uint8Array(32),
  });
  env.expectFail([ix], [evil], "Unauthorized");
  // and the valid one passes at exactly the boundary floor
  env.send([(await openRound(w, plan, epoch, expiry, { strike, size, floor: minPremiumFloor(1000, notional, 10, expiry - env.now()) })).ix], ag);
  // second round while one is active
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size })).ix], ag, "ActiveRoundExists");
});

test("open_round: expiry beyond user max / horizon, auction window, epoch kind mismatch, paused", async () => {
  const { w, strike, size, epoch, expiry, plan } = await ready({ planExtra: { maxExpirySecs: 300 } });
  const { env, agent, admin, user } = w;
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size })).ix], [agent], "ExpiryOutOfBounds");

  // new plan with normal max expiry; outside the 60 s quick auction window
  const plan2 = await createQuickBuyPlan(w, strike, size, 2);
  env.warp(70);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.expectFail([(await openRound(w, plan2, epoch, expiry, { strike, size })).ix], [agent], "OutsideAuctionWindow");

  // std epoch with a quick plan → EpochKindMismatch
  const stdExp = nextStdExpiry(env.now(), 13 * 3600);
  env.send([await env.client.openEpoch(admin.publicKey, WSOL_MINT, "std", stdExp)], [admin]);
  const stdEpoch = epochPda(w.asset, 0, stdExp)[0];
  env.expectFail([(await openRound(w, plan2, stdEpoch, stdExp, { strike, size })).ix], [agent], "EpochKindMismatch");

  // paused (global / plan)
  const { epoch: e2, expiry: x2 } = await openQuickEpoch(w);
  env.send([await env.client.setPaused(admin.publicKey, true)], [admin]);
  env.expectFail([(await openRound(w, plan2, e2, x2, { strike, size })).ix], [agent], "Paused");
  env.send([await env.client.setPaused(admin.publicKey, false)], [admin]);
  env.send([await env.client.pausePlan(user.publicKey, plan2, true)], [user]);
  env.expectFail([(await openRound(w, plan2, e2, x2, { strike, size })).ix], [agent], "PlanPaused");
  env.send([await env.client.pausePlan(user.publicKey, plan2, false)], [user]);
  // stale spot
  shiftPushFeed(env, SOL_FEED, env.now() - 181);
  env.expectFail([(await openRound(w, plan2, e2, x2, { strike, size })).ix], [agent], "StalePrice");
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.send([(await openRound(w, plan2, e2, x2, { strike, size })).ix], [agent]);
});

test("std epoch: schedule check, 08:00 UTC auction window, ≥12 h to expiry", async () => {
  const w = await setupWorld();
  const { env, admin, agent } = w;
  fundMaker(w, w.maker);
  // InvalidSchedule
  env.expectFail([await env.client.openEpoch(admin.publicKey, WSOL_MINT, "std", nextStdExpiry(env.now(), 3600) + 60)], [admin], "InvalidSchedule");
  env.expectFail([await env.client.openEpoch(admin.publicKey, WSOL_MINT, "quick", Math.floor(env.now() / 600) * 600 + 1210)], [admin], "InvalidSchedule");
  // move to the next 08:05 UTC, open tomorrow's 08:00 epoch
  const next0800 = nextStdExpiry(env.now());
  env.setTime(next0800 + 300);
  const expiry = next0800 + 86400;
  env.send([await env.client.openEpoch(admin.publicKey, WSOL_MINT, "std", expiry)], [admin]);
  const epoch = epochPda(w.asset, 0, expiry)[0];
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  const spot = realSpotUsdc(w);
  const strike = (spot / 1_000_000n - 5n) * 1_000_000n;
  env.setTokenBalance(USDC_MINT, w.user.publicKey, 10_000_000_000n);
  const { ixs, plan } = await env.client.createPlan(w.user.publicKey, WSOL_MINT, {
    nonce: 9, side: "buy", quick: false, targetStrike: strike, sizeTotal: 1_000_000_000n,
    minPremiumBpsPerDay: 10, maxExpirySecs: 7 * 86400, horizonEnd: env.now() + 30 * 86400, maxRoundsPerDay: 6,
  });
  env.send(ixs, [w.user]);
  // quick epoch with a std plan → mismatch
  const { epoch: qe, expiry: qx } = await openQuickEpoch(w);
  env.expectFail([(await openRound(w, plan, qe, qx, { strike, size: 100_000_000n })).ix], [agent], "EpochKindMismatch");
  // now inside 08:00–08:30 window (openQuickEpoch moved the clock ≤ 10 min)
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  assert.ok((env.now() - 28800) % 86400 < 1800, "inside std window");
  env.send([(await openRound(w, plan, epoch, expiry, { strike, size: 100_000_000n, auctionSecs: 60 })).ix], [agent]);
  // cancel it (owner) and try outside the window
  const r = env.decode<any>("plan", plan);
  const { roundPda } = await import("@bide/shared");
  const round0 = roundPda(plan, 0)[0];
  env.send([await env.client.cancelRound(w.user.publicKey, round0, env.decode<any>("round", round0))], [w.user]);
  env.setTime(next0800 + 1900);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size: 100_000_000n, auctionSecs: 60 })).ix], [agent], "OutsideAuctionWindow");
  void r;
});

test("take_round: spot guard, auction over, double take; cancel permissions", async () => {
  const { w, strike, size, epoch, expiry, plan } = await ready();
  const { env, agent, user, maker } = w;
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  env.warp(3);
  // spot moved +1% (> 50 bps) since open
  shiftPushFeed(env, SOL_FEED, env.now() - 1, { num: 101n, den: 100n });
  env.expectFail(await takeIt(w, o.round), [maker], "SpotMovedTooMuch");
  shiftPushFeed(env, SOL_FEED, env.now() - 1, { num: 100n, den: 101n });
  // stranger can't cancel during auction; agent can't before pool window
  const stranger = env.newWallet(1);
  const r = env.decode<any>("round", o.round);
  env.expectFail([await env.client.cancelRound(stranger.publicKey, o.round, r)], [stranger], "Unauthorized");
  env.expectFail([await env.client.cancelRound(agent.publicKey, o.round, r)], [agent], "Unauthorized");
  // after auction + pool delay: take is over
  env.warp(30 + 10 + 1);
  shiftPushFeed(env, SOL_FEED, env.now() - 1);
  env.expectFail(await takeIt(w, o.round), [maker], "AuctionOver");
  // agent can cancel now; stranger only 60 s later
  env.expectFail([await env.client.cancelRound(stranger.publicKey, o.round, r)], [stranger], "Unauthorized");
  env.warp(60);
  const agent0 = env.lamports(agent.publicKey);
  env.send([await env.client.cancelRound(stranger.publicKey, o.round, r)], [stranger]);
  assert.ok(!env.exists(o.round));
  assert.ok(env.lamports(agent.publicKey) > agent0, "rent back to agent (rent_payer)");
  assert.equal(env.decode<any>("plan", plan).activeRound, null);
  void user;
});

test("post_sample / resolve_epoch: wrong feed, partial verification, outside bucket, duplicate, wide conf, early resolve", async () => {
  const { w, epoch, expiry } = await ready();
  const { env, admin } = w;
  const c = env.client;
  const ws = windowStart(expiry, "Quick");
  env.setTime(ws + 1);
  const post = async (pu: any, b: number) => [await c.postSample(WSOL_MINT, epoch, pu, b)];
  env.expectFail(await post(cloneSample(w, ws, undefined, { feedIdHex: PYTH_FEED_IDS.BTC_USD }), 0), [admin], "WrongFeed");
  env.expectFail(await post(cloneSample(w, ws, undefined, { partial: true }), 0), [admin], "NotFullyVerified");
  env.expectFail(await post(cloneSample(w, ws + 3), 0), [admin], "SampleOutsideBucket"); // > tolerance
  env.expectFail(await post(cloneSample(w, ws - 1), 0), [admin], "SampleOutsideBucket"); // before bucket
  env.expectFail(await post(cloneSample(w, ws, undefined, { confMul: 1000n }), 0), [admin], "PriceConfidenceTooWide");
  env.expectFail(await post(cloneSample(w, ws), 10), [admin], "BucketOutOfRange");
  // a non-receiver-owned account
  const fake = Keypair.generate().publicKey;
  env.setRaw(fake, env.getData(SOL_FEED)!, admin.publicKey);
  env.expectFail(await post(fake, 0), [admin], "WrongFeed");
  env.send(await post(cloneSample(w, ws), 0), [admin]);
  env.expectFail(await post(cloneSample(w, ws), 0), [admin], "BucketFilled");
  assert.ok("sampling" in env.decode<any>("epoch", epoch).status);
  // 7 of 10 filled, past expiry but before grace end → NotEnoughSamples; at grace end → Failed
  for (let b = 1; b < 7; b++) {
    const bs = ws + b * 10;
    env.setTime(bs + 1);
    env.send(await post(cloneSample(w, bs), b), [admin]);
  }
  env.setTime(expiry + 5);
  env.expectFail([await c.resolveEpoch(epoch)], [admin], "NotEnoughSamples");
  env.setTime(expiry + 120);
  env.send([await c.resolveEpoch(epoch)], [admin]);
  assert.ok("failed" in env.decode<any>("epoch", epoch).status);
  // posting closed after grace
  env.expectFail(await post(cloneSample(w, ws + 90), 9), [admin], "EpochNotOpen");
});

test("resolve with n−2 samples after grace uses the median", async () => {
  const { w, epoch, expiry } = await ready();
  const { env, admin } = w;
  await sampleQuickEpoch(w, epoch, expiry, undefined, 8);
  env.setTime(expiry + 1);
  env.expectFail([await env.client.resolveEpoch(epoch)], [admin], "NotEnoughSamples");
  env.setTime(expiry + 120);
  env.send([await env.client.resolveEpoch(epoch)], [admin]);
  const e = env.decode<any>("epoch", epoch);
  assert.ok("resolved" in e.status);
  assert.equal(e.settlePrice.toString(), realSpotUsdc(w).toString());
});

test("unwind: rejected on a resolvable epoch, allowed on Failed; pending settlement blocks open/expire/close", async () => {
  const { w, strike, size, epoch, expiry, plan } = await ready({ size: 400_000_000n });
  const { env, agent, maker, user } = w;
  const c = env.client;
  const o = await openRound(w, plan, epoch, expiry, { strike, size: 200_000_000n });
  env.send([o.ix], [agent]);
  env.warp(5);
  env.send(await takeIt(w, o.round), [maker]);
  const keeper = env.newWallet(1);
  // epoch still Open → unwind rejected
  env.expectFail(await c.unwindRound(keeper.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [keeper], "WrongStatus");
  // no samples at all → Failed after grace
  env.setTime(expiry + 120);
  env.send([await c.resolveEpoch(epoch)], [keeper]);
  // resolve_round on a Failed epoch → EpochFailed
  env.expectFail(await c.resolveRound(keeper.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [keeper], "EpochFailed");
  const makerWsol0 = env.tokenBalance(ata(WSOL_MINT, maker.publicKey));
  env.send(await c.unwindRound(keeper.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [keeper]);
  assert.equal(env.tokenBalance(ata(WSOL_MINT, maker.publicKey)) - makerWsol0, 200_000_000n, "escrow back to maker");
  assert.ok(!env.exists(o.round));
  assert.equal(env.decode<any>("plan", plan).activeRound, null);

  // exercised round → pending settlement blocks open_round / expire / close until withdraw
  const { epoch: e2, expiry: x2 } = await openQuickEpoch(w);
  const strikeItm = (realSpotUsdc(w) / 1_000_000n - 3n) * 1_000_000n; // plan target = strike; put exercised iff settle < strike
  void strikeItm;
  const o2 = await openRound(w, plan, e2, x2, { strike, size: 200_000_000n });
  env.send([o2.ix], [agent]);
  env.warp(5);
  env.send(await takeIt(w, o2.round), [maker]);
  await sampleQuickEpoch(w, e2, x2, { num: 90n, den: 100n }); // price −10% → put exercised
  env.setTime(x2);
  env.send([await c.resolveEpoch(e2)], [keeper]);
  env.send(await c.resolveRound(keeper.publicKey, o2.round, env.decode<any>("round", o2.round), env.decode<any>("plan", plan)), [keeper]);
  const pp = env.decode<any>("plan", plan);
  assert.ok(pp.pendingSettlement);
  const { epoch: e3, expiry: x3 } = await openQuickEpoch(w);
  env.expectFail([(await openRound(w, plan, e3, x3, { strike, size: 100_000_000n })).ix], [agent], "SettlementPending");
  env.expectFail(await c.closePlan(user.publicKey, plan, pp), [user], "SettlementPending");
  env.setTime(Number(pp.horizonEnd) + 1);
  env.expectFail(await c.closePlan(keeper.publicKey, plan, pp, true), [keeper], "SettlementPending");
  env.send(await c.withdrawCollateral(keeper.publicKey, o2.round, env.decode<any>("round", o2.round), pp), [keeper]);
  // expire by anyone after horizon → funds to owner
  const u0 = env.tokenBalance(ata(USDC_MINT, user.publicKey));
  env.send(await c.closePlan(keeper.publicKey, plan, env.decode<any>("plan", plan), true), [keeper]);
  assert.ok(env.tokenBalance(ata(USDC_MINT, user.publicKey)) > u0, "remaining collateral to owner");
  assert.ok("closed" in env.decode<any>("plan", plan).status);
});

test("expire_plan before horizon fails; close_plan by non-owner fails; rate limit", async () => {
  const { w, strike, epoch, expiry, plan } = await ready({ planExtra: { maxRoundsPerDay: 1 } });
  const { env, agent, user } = w;
  const c = env.client;
  const stranger = env.newWallet(1);
  const p = env.decode<any>("plan", plan);
  env.expectFail(await c.closePlan(stranger.publicKey, plan, p, true), [stranger], "PlanNotExpired");
  env.expectFail(await c.closePlan(stranger.publicKey, plan, p, false), [stranger], "Unauthorized");
  const o = await openRound(w, plan, epoch, expiry, { strike, size: 100_000_000n });
  env.send([o.ix], [agent]);
  env.send([await c.cancelRound(user.publicKey, o.round, env.decode<any>("round", o.round))], [user]);
  const { epoch: e2, expiry: x2 } = await openQuickEpoch(w);
  if (Math.floor(x2 / 86400) === Math.floor(expiry / 86400) || true) {
    env.expectFail([(await openRound(w, plan, e2, x2, { strike, size: 100_000_000n })).ix], [agent], "RateLimited");
  }
});

test("admin: fee cap, non-admin rejected", async () => {
  const w = await setupWorld();
  const { env, admin } = w;
  env.expectFail([await env.client.setFee(admin.publicKey, 2001, admin.publicKey)], [admin], "FeeTooHigh");
  const evil = env.newWallet(1);
  env.expectFail([await env.client.setPaused(evil.publicKey, true)], [evil], "Unauthorized");
  env.send([await env.client.setFee(admin.publicKey, 2000, admin.publicKey)], [admin]);
});
