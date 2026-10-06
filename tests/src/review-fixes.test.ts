// Regression tests for the Fable review fixes (2026-10-05). Each fails on the pre-fix build
// (BIDE_SO=<pre-fix .so>) and passes on the fixed build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransferInstruction } from "@solana/spl-token";
import {
  ata, escrowPda, lendAuthPda, notionalFloor, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, WSOL_MINT, LEND_MARKETS,
} from "@bide/shared";
import { SystemProgram } from "@solana/web3.js";
import { setupWorld, shiftPushFeed, SOL_FEED, World } from "./fixtures.js";
import { createQuickBuyPlan, fundMaker, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

const POOL = { maxPremiumBpsOfNotional: 150, maxOpenNotional: 1_000_000_000n, maxUtilizationBps: 8000, spendWindowSecs: 86400, spendWindowCap: 100_000_000n };

async function base() {
  const w = await setupWorld();
  fundMaker(w, w.maker);
  const spot = realSpotUsdc(w);
  return { w, spot };
}

function donate(w: World, mint: any, to: any, amount: bigint) {
  const d = w.env.newWallet(1);
  w.env.setTokenBalance(mint, d.publicKey, amount);
  w.env.send([createTransferInstruction(ata(mint, d.publicKey), to, d.publicKey, amount)], [d]);
}

test("fix 1: a donation into the escrow cannot block cancel_round (surplus swept to the owner)", async () => {
  const { w, spot } = await base();
  const { env, agent, user } = w;
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, 200_000_000n);
  const o = await openRound(w, plan, epoch, expiry, { strike, size: 200_000_000n });
  env.send([o.ix], [agent]);
  donate(w, WSOL_MINT, escrowPda(o.round)[0], 1n);
  const r = env.decode<any>("round", o.round);
  const p = env.decode<any>("plan", plan);
  env.send(await env.client.cancelRoundIxs(user.publicKey, o.round, r, p), [user]);
  assert.ok(!env.exists(o.round), "round closed");
  assert.equal(env.decode<any>("plan", plan).activeRound, null, "plan unlocked");
  assert.equal(env.tokenBalance(ata(WSOL_MINT, user.publicKey)), 1n, "surplus swept to owner");
});

test("fix 1b: donations into a Live escrow don't block resolve_round / unwind_round", async () => {
  const { w, spot } = await base();
  const { env, agent, maker } = w;
  const c = env.client;
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, 200_000_000n);
  const o = await openRound(w, plan, epoch, expiry, { strike, size: 200_000_000n });
  env.send([o.ix], [agent]);
  env.warp(5);
  const r = env.decode<any>("round", o.round);
  env.send(await c.takeRound(maker.publicKey, o.round, r, env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey), [maker]);
  donate(w, WSOL_MINT, escrowPda(o.round)[0], 7n);
  env.setTime(expiry + 120);
  env.send([await c.resolveEpoch(epoch)], [agent]); // no samples → Failed
  const m0 = env.tokenBalance(ata(WSOL_MINT, maker.publicKey));
  env.send(await c.unwindRound(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  assert.equal(env.tokenBalance(ata(WSOL_MINT, maker.publicKey)) - m0, 200_000_007n);
  assert.equal(env.decode<any>("plan", plan).activeRound, null);
});

test("fix 2: pool_take_round has a deadline (AuctionOver after the permissionless-cancel point)", async () => {
  const { w, spot } = await base();
  const { env, admin, agent } = w;
  const c = env.client;
  env.send(await c.initPool(admin.publicKey, POOL), [admin]);
  env.setTokenBalance(USDC_MINT, admin.publicKey, 500_000_000n);
  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, 500_000_000n), [admin]);
  env.setTokenBalance(WSOL_MINT, admin.publicKey, 0n);
  env.send([...env.wrapIxs(admin.publicKey, 2_000_000_000n), ...(await c.poolDeposit(admin.publicKey, WSOL_MINT, 2_000_000_000n))], [admin]);
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, 200_000_000n);
  const o = await openRound(w, plan, epoch, expiry, { strike, size: 200_000_000n });
  env.send([o.ix], [agent]);
  env.warp(30 + 10 + 61);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  const r = env.decode<any>("round", o.round);
  env.expectFail(
    await c.poolTakeRound(admin.publicKey, o.round, r, env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey),
    [admin],
    "AuctionOver",
  );
});

test("fix 3a: open_round rejects rounds below 1 USDC notional (RoundTooSmall)", async () => {
  const { w, spot } = await base();
  const { env, agent } = w;
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, 200_000_000n);
  const size = 5_000_000n; // 0.005 SOL ≈ 0.58 USDC
  assert.ok(notionalFloor(strike, size, 9) < 1_000_000n);
  env.expectFail([(await openRound(w, plan, epoch, expiry, { strike, size, floor: 100_000n, start: 200_000n })).ix], [agent], "RoundTooSmall");
});

test("fix 3b: withdraw_collateral never asks Lend for a near-zero amount (pre-staged donation)", async () => {
  const { w, spot } = await base();
  const { env, agent, maker } = w;
  const c = env.client;
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const size = 200_000_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, size);
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  env.warp(5);
  env.send(await c.takeRound(maker.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey), [maker]);
  await sampleQuickEpoch(w, epoch, expiry, { num: 90n, den: 100n });
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [agent]);
  env.send(await c.resolveRound(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  // someone pre-stages all but 5 units of the owed USDC into the plan's staging vault
  const [lendAuth] = lendAuthPda(plan);
  donate(w, USDC_MINT, ata(USDC_MINT, lendAuth), o.notional - 5n);
  const m0 = env.tokenBalance(ata(USDC_MINT, maker.publicKey));
  env.send(await c.withdrawCollateral(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  assert.equal(env.tokenBalance(ata(USDC_MINT, maker.publicKey)) - m0, o.notional, "maker paid exactly notional");
  assert.equal(env.decode<any>("plan", plan).pendingSettlement, null);
});

test("fix 4: exercised pool put books a USDC receivable until withdraw_collateral (no NAV dip)", async () => {
  const { w, spot } = await base();
  const { env, admin, agent } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  env.send(await c.initPool(admin.publicKey, POOL), [admin]);
  env.setTokenBalance(USDC_MINT, admin.publicKey, 500_000_000n);
  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, 500_000_000n), [admin]);
  env.setTokenBalance(WSOL_MINT, admin.publicKey, 0n);
  env.send([...env.wrapIxs(admin.publicKey, 2_000_000_000n), ...(await c.poolDeposit(admin.publicKey, WSOL_MINT, 2_000_000_000n))], [admin]);
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const size = 200_000_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, size);
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  env.warp(41);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.send(await c.poolTakeRound(admin.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey), [admin]);
  await sampleQuickEpoch(w, epoch, expiry, { num: 90n, den: 100n });
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [agent]);
  env.send(await c.resolveRound(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  let pool = env.decode<any>("pool", pa.pool);
  assert.equal(pool.reservedWsol.toString(), "0");
  assert.equal(pool.reservedUsdc.toString(), o.notional.toString(), "receivable booked at resolve");
  assert.equal(pool.openNotional.toString(), "0");
  const u0 = env.tokenBalance(pa.poolUsdc);
  env.send(await c.withdrawCollateral(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  pool = env.decode<any>("pool", pa.pool);
  assert.equal(pool.reservedUsdc.toString(), "0", "receivable released");
  assert.equal(env.tokenBalance(pa.poolUsdc) - u0, o.notional);
});

test("fix 5: Wheel close_plan in Accumulate must include the asset vault (no stranded WSOL)", async () => {
  const { w, spot } = await base();
  const { env, agent, maker, user } = w;
  const c = env.client;
  const target = (spot / 100_000n - 20n) * 100_000n;
  const exit = (spot / 100_000n + 20n) * 100_000n;
  const size = 200_000_000n;
  env.setTokenBalance(USDC_MINT, user.publicKey, 1_000_000_000n);
  const { ixs, plan } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 21, side: "wheel", quick: true, targetStrike: target, exitStrike: exit, sizeTotal: size,
    minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 3 * 86400, maxRoundsPerDay: 30,
  });
  env.send(ixs, [user]);
  const { epoch, expiry } = await openQuickEpoch(w);
  const o = await openRound(w, plan, epoch, expiry, { strike: target, size });
  env.send([o.ix], [agent]);
  env.warp(5);
  env.send(await c.takeRound(maker.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey), [maker]);
  await sampleQuickEpoch(w, epoch, expiry, { num: 90n, den: 100n });
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [agent]);
  env.send(await c.resolveRound(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  env.send(await c.withdrawCollateral(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);
  const [lendAuth] = lendAuthPda(plan);
  assert.equal(env.tokenBalance(ata(WSOL_MINT, lendAuth)), size);
  // hand-built close without vault_asset / owner_asset
  const bad = await c.program.methods
    .closePlan()
    .accountsPartial({
      caller: user.publicKey, plan, lendAuth,
      vaultCollateral: ata(USDC_MINT, lendAuth), vaultFToken: ata(LEND_MARKETS.USDC.fTokenMint, lendAuth),
      ownerCollateral: ata(USDC_MINT, user.publicKey), vaultAsset: null, ownerAsset: null,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .remainingAccounts((await import("@bide/shared")).lendMarketMetas(LEND_MARKETS.USDC))
    .instruction();
  env.expectFail([bad], [user], "InvalidAccount");
  env.send(await c.closePlan(user.publicKey, plan, env.decode<any>("plan", plan)), [user]);
  assert.equal(env.tokenBalance(ata(WSOL_MINT, user.publicKey)), size, "filled SOL returned to owner");
});

test("fix 6: pool first-depositor inflation attack is unprofitable (virtual shares)", async () => {
  const w = await setupWorld();
  const { env, admin } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  env.send(await c.initPool(admin.publicKey, POOL), [admin]);
  const attacker = env.newWallet(5);
  const victim = env.newWallet(5);
  env.setTokenBalance(USDC_MINT, attacker.publicKey, 1_000_000_001n);
  env.send(await c.poolDeposit(attacker.publicKey, USDC_MINT, 1n), [attacker]);
  env.send([createTransferInstruction(ata(USDC_MINT, attacker.publicKey), pa.poolUsdc, attacker.publicKey, 1_000_000_000n)], [attacker]);
  env.setTokenBalance(USDC_MINT, victim.publicKey, 1_500_000_000n);
  env.send(await c.poolDeposit(victim.publicKey, USDC_MINT, 1_500_000_000n), [victim]);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  const shares = env.tokenBalance(ata(pa.shareMint, attacker.publicKey));
  env.send(await c.poolWithdraw(attacker.publicKey, shares), [attacker]);
  const got = env.tokenBalance(ata(USDC_MINT, attacker.publicKey));
  console.log("attacker spent 1,000.000001 USDC, got back", got);
  assert.ok(got < 1_000_000_001n, "attack loses money");
  // the victim keeps (almost) all of their deposit
  const vs = env.tokenBalance(ata(pa.shareMint, victim.publicKey));
  env.send(await c.poolWithdraw(victim.publicKey, vs), [victim]);
  const vgot = env.tokenBalance(ata(USDC_MINT, victim.publicKey));
  console.log("victim deposited 1,500 USDC, got back", vgot);
  // bounded rounding cost of virtual shares (OZ-style): < 0.1% of the deposit; pre-fix the victim lost ~250 USDC
  assert.ok(vgot >= 1_498_500_000n, "victim loss bounded below 0.1%");
});
