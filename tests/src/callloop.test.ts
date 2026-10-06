// Call loop (Sell plan, covered call): WSOL in Jupiter Lend WSOL market; maker escrows notional USDC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ata, escrowPda, feeOf, auctionPrice, notionalFloor, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { setupWorld } from "./fixtures.js";
import { fundMaker, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

async function callLoop(exercise: boolean) {
  const w = await setupWorld();
  const { env, user, maker, agent, feeRecipient } = w;
  const c = env.client;
  fundMaker(w, maker);
  const spot = realSpotUsdc(w);
  // ITM call (strike below spot) → exercised
  const strike = ((spot / 1_000_000n) + (exercise ? -5n : 5n)) * 1_000_000n;
  const size = 300_000_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  env.setTokenBalance(WSOL_MINT, user.publicKey, 0n);
  env.setTokenBalance(USDC_MINT, user.publicKey, 0n);
  const { ixs, plan } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 3, side: "sell", quick: true, exitStrike: strike, sizeTotal: size,
    minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 2 * 86400, maxRoundsPerDay: 30,
  });
  env.send([...env.wrapIxs(user.publicKey, size + 10n), ...ixs], [user]);
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  const r0 = env.decode<any>("round", o.round);
  assert.ok("call" in r0.kind);
  env.warp(5);
  const price = auctionPrice(o.start, o.floor, Number(r0.auctionStart), r0.auctionSecs, env.now());
  env.send(await c.takeRound(maker.publicKey, o.round, r0, env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), feeRecipient.publicKey), [maker]);
  const notional = notionalFloor(strike, size, 9);
  assert.equal(env.tokenBalance(escrowPda(o.round)[0]), notional, "maker escrowed notional USDC");
  const userUsdc = ata(USDC_MINT, user.publicKey);
  assert.equal(env.tokenBalance(userUsdc), price - feeOf(price, 1000));

  await sampleQuickEpoch(w, epoch, expiry);
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [w.admin]);
  const keeper = env.newWallet(1);
  const rl = env.decode<any>("round", o.round);
  const makerWsol0 = env.tokenBalance(ata(WSOL_MINT, maker.publicKey));
  const makerUsdc0 = env.tokenBalance(ata(USDC_MINT, maker.publicKey));
  env.send(await c.resolveRound(keeper.publicKey, o.round, rl, env.decode<any>("plan", plan)), [keeper]);
  if (exercise) {
    assert.equal(env.tokenBalance(userUsdc), price - feeOf(price, 1000) + notional, "user got K×Q USDC");
    const pp = env.decode<any>("plan", plan);
    const rr = env.decode<any>("round", o.round);
    env.send(await c.withdrawCollateral(keeper.publicKey, o.round, rr, pp), [keeper]);
    assert.equal(env.tokenBalance(ata(WSOL_MINT, maker.publicKey)) - makerWsol0, size, "maker got Q SOL from Lend");
    const pp2 = env.decode<any>("plan", plan);
    assert.ok("filled" in pp2.status);
    env.send(await c.closePlan(user.publicKey, plan, pp2), [user]);
  } else {
    assert.equal(env.tokenBalance(ata(USDC_MINT, maker.publicKey)) - makerUsdc0, notional, "maker USDC back");
    const pp = env.decode<any>("plan", plan);
    env.send(await c.closePlan(user.publicKey, plan, pp), [user]);
    assert.ok(env.tokenBalance(ata(WSOL_MINT, user.publicKey)) >= size, "user keeps SOL");
  }
}

test("call loop — exercised: user gets K×Q USDC, maker gets Q WSOL via Lend withdraw-by-amount", async () => {
  await callLoop(true);
});
test("call loop — not exercised: maker USDC back, user keeps SOL + premium", async () => {
  await callLoop(false);
});
