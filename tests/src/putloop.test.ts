// Phase-1 exit: full put loop (exercised + not exercised) on LiteSVM against real devnet Lend/Pyth binaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ata, escrowPda, feeOf, auctionPrice, lendAuthPda, LEND_MARKETS, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { setupWorld } from "./fixtures.js";
import { createQuickBuyPlan, fundMaker, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

async function putLoop(exercise: boolean) {
  const w = await setupWorld();
  const { env, user, maker, agent, feeRecipient } = w;
  const c = env.client;
  fundMaker(w, maker);
  const spot = realSpotUsdc(w);
  // ITM put (strike above spot) → exercised; OTM (below) → not
  const strike = ((spot / 1_000_000n) + (exercise ? 5n : -5n)) * 1_000_000n;
  const size = 200_000_000n; // 0.2 SOL
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, size);
  const userUsdc = ata(USDC_MINT, user.publicKey);
  const usdcAfterCreate = env.tokenBalance(userUsdc);

  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  const r0 = env.decode<any>("round", o.round);
  assert.ok("auction" in r0.status);
  console.log(`spot ${spot} strike ${strike} notional ${o.notional} floor ${o.floor} start ${o.start}`);

  env.warp(10);
  const r = env.decode<any>("round", o.round);
  const p = env.decode<any>("plan", plan);
  const asset = env.decode<any>("asset", w.asset);
  const price = auctionPrice(o.start, o.floor, Number(r.auctionStart), r.auctionSecs, env.now());
  const makerUsdc0 = env.tokenBalance(ata(USDC_MINT, maker.publicKey));
  env.send(await c.takeRound(maker.publicKey, o.round, r, p, asset, feeRecipient.publicKey), [maker]);
  const fee = feeOf(price, 1000);
  assert.equal(env.tokenBalance(ata(USDC_MINT, feeRecipient.publicKey)), fee);
  assert.equal(env.tokenBalance(userUsdc) - usdcAfterCreate, price - fee);
  assert.equal(makerUsdc0 - env.tokenBalance(ata(USDC_MINT, maker.publicKey)), price);
  assert.equal(env.tokenBalance(escrowPda(o.round)[0]), size);
  const rl = env.decode<any>("round", o.round);
  assert.ok("live" in rl.status);
  assert.equal(rl.premiumPaid.toString(), price.toString());
  console.log(`premium ${price} fee ${fee}`);

  await sampleQuickEpoch(w, epoch, expiry);
  // early resolve before expiry fails
  env.expectFail([await c.resolveEpoch(epoch)], [w.admin], "NotEnoughSamples");
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [w.admin]);
  const e = env.decode<any>("epoch", epoch);
  assert.ok("resolved" in e.status);
  console.log("settle_price", e.settlePrice.toString());

  const keeper = env.newWallet(1);
  const agentLamports0 = env.lamports(agent.publicKey);
  env.send(await c.resolveRound(keeper.publicKey, o.round, rl, env.decode<any>("plan", plan)), [keeper]);
  const userWsol = ata(WSOL_MINT, user.publicKey);
  if (exercise) {
    assert.equal(env.tokenBalance(userWsol), size, "user received the SOL");
    const rr = env.decode<any>("round", o.round);
    assert.equal(rr.exercised, 2);
    const pp = env.decode<any>("plan", plan);
    assert.equal(pp.pendingSettlement?.toBase58(), o.round.toBase58());
    assert.ok("filled" in pp.status);
    // pending settlement blocks close
    env.expectFail(await c.closePlan(user.publicKey, plan, pp), [user], "SettlementPending");

    const [lendAuth] = lendAuthPda(plan);
    const shares0 = env.tokenBalance(ata(LEND_MARKETS.USDC.fTokenMint, lendAuth));
    const makerUsdc1 = env.tokenBalance(ata(USDC_MINT, maker.publicKey));
    const m = env.send(await c.withdrawCollateral(keeper.publicKey, o.round, rr, pp), [keeper]);
    console.log("withdraw_collateral CU", m.computeUnitsConsumed().toString());
    const paid = env.tokenBalance(ata(USDC_MINT, maker.publicKey)) - makerUsdc1;
    const shares1 = env.tokenBalance(ata(LEND_MARKETS.USDC.fTokenMint, lendAuth));
    console.log(`maker paid ${paid} (owed ${o.notional}); shares burned ${shares0 - shares1}`);
    assert.equal(paid, o.notional, "maker receives exactly notional");
    assert.ok(!env.exists(o.round), "round closed");
    const pp2 = env.decode<any>("plan", plan);
    assert.equal(pp2.pendingSettlement, null);
    assert.equal(pp2.lendShares.toString(), shares1.toString());
    // remaining collateral (target−strike rounding) + yield goes back on close
    const u0 = env.tokenBalance(userUsdc);
    env.send(await c.closePlan(user.publicKey, plan, pp2), [user]);
    console.log("returned on close", env.tokenBalance(userUsdc) - u0);
  } else {
    assert.equal(env.tokenBalance(userWsol), 0n);
    assert.ok(!env.exists(o.round), "round closed");
    assert.ok(!env.exists(escrowPda(o.round)[0]), "escrow closed");
    assert.ok(env.lamports(agent.publicKey) > agentLamports0, "rent back to agent");
    const pp = env.decode<any>("plan", plan);
    assert.equal(pp.activeRound, null);
    assert.ok("active" in pp.status);
    const u0 = env.tokenBalance(userUsdc);
    env.send(await c.closePlan(user.publicKey, plan, pp), [user]);
    const back = env.tokenBalance(userUsdc) - u0;
    console.log("returned on close", back, "of principal", pp.collateralPrincipal.toString());
    assert.ok(back >= BigInt(pp.collateralPrincipal.toString()) - 1n);
  }
}

test("put loop — exercised: user gets SOL at strike, maker gets notional via Lend withdraw-by-amount", async () => {
  await putLoop(true);
});

test("put loop — not exercised: maker gets SOL back, user keeps premium + USDC", async () => {
  await putLoop(false);
});
