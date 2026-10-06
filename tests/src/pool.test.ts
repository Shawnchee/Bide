// Backstop pool: deposits, pool_take_round after the pool window, exposure release on unwind, LP withdraw, Lend idle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ata, escrowPda, USDC_MINT, WSOL_MINT, LEND_MARKETS } from "@bide/shared";
import { setupWorld, shiftPushFeed, SOL_FEED } from "./fixtures.js";
import { createQuickBuyPlan, openQuickEpoch, openRound, realSpotUsdc } from "./flows.js";

const PARAMS = { maxPremiumBpsOfNotional: 150, maxOpenNotional: 1_000_000_000n, maxUtilizationBps: 8000, spendWindowSecs: 86400, spendWindowCap: 100_000_000n };

test("pool: deposit, pool_take_round (put), unwind releases exposure, LP withdraw, lend idle/unlend", async () => {
  const w = await setupWorld();
  const { env, admin, agent, feeRecipient, user } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  // only config admin can init
  env.expectFail(await c.initPool(user.publicKey, PARAMS), [user], "Unauthorized");
  env.send(await c.initPool(admin.publicKey, PARAMS), [admin]);

  // LP 1: 500 USDC; LP 2: 2 SOL
  env.setTokenBalance(USDC_MINT, admin.publicKey, 500_000_000n);
  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, 500_000_000n), [admin]);
  const lp2 = env.newWallet(10);
  env.setTokenBalance(WSOL_MINT, lp2.publicKey, 0n);
  env.send([...env.wrapIxs(lp2.publicKey, 2_000_000_000n), ...(await c.poolDeposit(lp2.publicKey, WSOL_MINT, 2_000_000_000n))], [lp2]);
  const s1 = env.tokenBalance(ata(pa.shareMint, admin.publicKey));
  const s2 = env.tokenBalance(ata(pa.shareMint, lp2.publicKey));
  const spot = realSpotUsdc(w);
  console.log("shares lp1", s1, "lp2", s2, "spot", spot);
  assert.equal(s1, 500_000_000n);
  assert.equal(s2, (spot * 2n), "2 SOL valued at spot");

  // park 200 USDC in Lend, then unlend 50
  env.send(await c.poolLend(admin.publicKey, 200_000_000n, true), [admin]);
  assert.ok(env.decode<any>("pool", pa.pool).lendShares.toNumber() > 0);
  env.send(await c.poolLend(agent.publicKey, 50_000_000n, false), [agent]);
  assert.equal(env.tokenBalance(pa.poolUsdc), 350_000_000n);
  env.expectFail(await c.poolLend(user.publicKey, 1_000_000n, true), [user], "Unauthorized");

  // round with no maker → pool takes it after auction + pool delay
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const size = 200_000_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, size);
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  const r = () => env.decode<any>("round", o.round);
  const take = async () => c.poolTakeRound(admin.publicKey, o.round, r(), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), feeRecipient.publicKey);
  env.expectFail(await take(), [admin], "PoolWindowNotReached");
  env.warp(41);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  // cap: premium above max_premium_bps_of_notional
  env.send([await c.setPoolParams(admin.publicKey, false, { ...PARAMS, maxPremiumBpsOfNotional: 0 })], [admin]);
  env.expectFail(await take(), [admin], "PoolCapExceeded");
  env.send([await c.setPoolParams(admin.publicKey, true, PARAMS)], [admin]);
  env.expectFail(await take(), [admin], "PoolPaused");
  env.send([await c.setPoolParams(admin.publicKey, false, PARAMS)], [admin]);
  const poolUsdc0 = env.tokenBalance(pa.poolUsdc);
  env.send(await take(), [admin]);
  const rl = r();
  assert.ok(rl.makerIsPool && "live" in rl.status);
  assert.equal(env.tokenBalance(escrowPda(o.round)[0]), size);
  assert.equal(poolUsdc0 - env.tokenBalance(pa.poolUsdc), BigInt(rl.premiumFloor.toString()), "pool paid the floor");
  let pool = env.decode<any>("pool", pa.pool);
  assert.equal(pool.reservedWsol.toString(), size.toString());
  assert.equal(pool.openNotional.toString(), o.notional.toString());

  // no samples → Failed → unwind returns escrow to the pool and releases exposure
  env.setTime(expiry + 120);
  env.send([await c.resolveEpoch(epoch)], [admin]);
  const wsol0 = env.tokenBalance(pa.poolWsol);
  env.send(await c.unwindRound(admin.publicKey, o.round, rl, env.decode<any>("plan", plan)), [admin]);
  assert.equal(env.tokenBalance(pa.poolWsol) - wsol0, size);
  pool = env.decode<any>("pool", pa.pool);
  assert.equal(pool.reservedWsol.toString(), "0");
  assert.equal(pool.openNotional.toString(), "0");

  // LP 2 withdraws everything, in kind
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.send(await c.poolWithdraw(lp2.publicKey, s2), [lp2]);
  const outU = env.tokenBalance(ata(USDC_MINT, lp2.publicKey));
  const outW = env.tokenBalance(ata(WSOL_MINT, lp2.publicKey));
  const outF = env.tokenBalance(ata(LEND_MARKETS.USDC.fTokenMint, lp2.publicKey));
  console.log("lp2 out: usdc", outU, "wsol", outW, "jlUSDC", outF);
  assert.ok(outW > 0n && outU > 0n && outF > 0n, "pro-rata in kind");
  assert.equal(env.tokenBalance(ata(pa.shareMint, lp2.publicKey)), 0n);
});

test("pool: withdraw blocked by InsufficientFreeFunds while funds are escrowed", async () => {
  const w = await setupWorld();
  const { env, admin, agent, feeRecipient } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  env.send(await c.initPool(admin.publicKey, { ...PARAMS, maxUtilizationBps: 10000 }), [admin]);
  // small pool: 1 USDC + 0.21 SOL, so a 0.2 SOL put escrow reserves most of it
  env.setTokenBalance(USDC_MINT, admin.publicKey, 1_000_000n);
  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, 1_000_000n), [admin]);
  env.setTokenBalance(WSOL_MINT, admin.publicKey, 0n);
  env.send([...env.wrapIxs(admin.publicKey, 210_000_000n), ...(await c.poolDeposit(admin.publicKey, WSOL_MINT, 210_000_000n))], [admin]);
  const spot = realSpotUsdc(w);
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const { epoch, expiry } = await openQuickEpoch(w);
  const plan = await createQuickBuyPlan(w, strike, 200_000_000n);
  const o = await openRound(w, plan, epoch, expiry, { strike, size: 200_000_000n });
  env.send([o.ix], [agent]);
  env.warp(41);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.send(await c.poolTakeRound(admin.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), feeRecipient.publicKey), [admin]);
  const all = env.tokenBalance(ata(pa.shareMint, admin.publicKey));
  env.expectFail(await c.poolWithdraw(admin.publicKey, all), [admin], "InsufficientFreeFunds");
});
