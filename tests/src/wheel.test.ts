// Wheel: puts until filled → flip_plan → covered calls at the exit strike, same plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ata, lendAuthPda, lendAltAddresses, LEND_MARKETS, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { setupWorld, World } from "./fixtures.js";
import { fundMaker, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

async function runRound(w: World, plan: any, strike: bigint, size: bigint, mul: { num: bigint; den: bigint }) {
  const { env, agent, maker, feeRecipient } = w;
  const c = env.client;
  const { epoch, expiry } = await openQuickEpoch(w);
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  env.warp(5);
  const r = env.decode<any>("round", o.round);
  env.send(await c.takeRound(maker.publicKey, o.round, r, env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), feeRecipient.publicKey), [maker]);
  await sampleQuickEpoch(w, epoch, expiry, mul);
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [w.admin]);
  const keeper = env.newWallet(1);
  env.send(await c.resolveRound(keeper.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [keeper]);
  const rr = env.decode<any>("round", o.round);
  assert.equal(rr.exercised, 2, "exercised");
  env.send(await c.withdrawCollateral(keeper.publicKey, o.round, rr, env.decode<any>("plan", plan)), [keeper]);
}

test("wheel: put fills into the plan vault, flip_plan moves to WSOL Lend, call fills at exit strike", async () => {
  const w = await setupWorld();
  const { env, user, agent, maker } = w;
  const c = env.client;
  fundMaker(w, maker);
  env.installAlt(lendAltAddresses()); // flip_plan carries 2 Lend markets → needs the ALT (as on devnet)
  const spot = realSpotUsdc(w);
  const target = (spot / 100_000n - 20n) * 100_000n; // $2 below spot
  const exit = (spot / 100_000n + 20n) * 100_000n; // $2 above spot
  const size = 200_000_000n;
  env.setTokenBalance(USDC_MINT, user.publicKey, 1_000_000_000n);
  const { ixs, plan } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 11, side: "wheel", quick: true, targetStrike: target, exitStrike: exit, sizeTotal: size,
    minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 3 * 86400, maxRoundsPerDay: 30,
  });
  env.send(ixs, [user]);
  // flip before fill → WrongPhase
  env.expectFail(await c.flipPlan(agent.publicKey, plan, env.decode<any>("plan", plan)), [agent], "WrongPhase", true);

  await runRound(w, plan, target, size, { num: 90n, den: 100n }); // −10% → put exercised
  const [lendAuth] = lendAuthPda(plan);
  assert.equal(env.tokenBalance(ata(WSOL_MINT, lendAuth)), size, "SOL delivered to the plan's asset vault, not the user");
  assert.equal(env.tokenBalance(ata(WSOL_MINT, user.publicKey)), 0n);
  let p = env.decode<any>("plan", plan);
  assert.ok("active" in p.status && "accumulate" in p.phase);

  const u0 = env.tokenBalance(ata(USDC_MINT, user.publicKey));
  // only the agent can flip
  env.expectFail(await c.flipPlan(user.publicKey, plan, p), [user], "Unauthorized", true);
  env.send(await c.flipPlan(agent.publicKey, plan, p), [agent], true);
  p = env.decode<any>("plan", plan);
  assert.ok("exit" in p.phase);
  assert.equal(p.sizeFilled.toString(), "0");
  assert.equal(p.sizeTotal.toString(), (size - 10n).toString(), "size = held − dust buffer");
  assert.ok(env.tokenBalance(ata(LEND_MARKETS.WSOL.fTokenMint, lendAuth)) > 0n, "SOL now in WSOL Lend");
  console.log("leftover USDC returned on flip:", env.tokenBalance(ata(USDC_MINT, user.publicKey)) - u0);
  // a second flip → WrongPhase
  env.expectFail(await c.flipPlan(agent.publicKey, plan, p), [agent], "WrongPhase", true);

  const callSize = BigInt(p.sizeTotal.toString());
  const usdcBefore = env.tokenBalance(ata(USDC_MINT, user.publicKey));
  await runRound(w, plan, exit, callSize, { num: 110n, den: 100n }); // +10% → call exercised
  const gained = env.tokenBalance(ata(USDC_MINT, user.publicKey)) - usdcBefore;
  console.log("call leg: user USDC gained (premium + K×Q):", gained);
  assert.ok(gained >= (exit * callSize) / 1_000_000_000n);
  p = env.decode<any>("plan", plan);
  env.send(await c.closePlan(user.publicKey, plan, p), [user]);
  assert.ok("closed" in env.decode<any>("plan", plan).status);
});
