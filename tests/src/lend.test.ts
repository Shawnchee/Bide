// Phase-1 first test: Jupiter Lend deposit / redeem from a PDA (lend_auth) via CPI, against the REAL devnet Lend binaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ata, lendAuthPda, LEND_MARKETS, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { setupWorld } from "./fixtures.js";

test("Buy plan: USDC → Jupiter Lend deposit from lend_auth PDA, then close_plan redeems all", async () => {
  const w = await setupWorld();
  const { env, user } = w;
  const c = env.client;
  const userUsdc = env.setTokenBalance(USDC_MINT, user.publicKey, 1_000_000_000n); // 1000 USDC
  const now = env.now();
  const { ixs, plan } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 1,
    side: "buy",
    quick: false,
    targetStrike: 110_000_000n,
    sizeTotal: 200_000_000n, // 0.2 SOL → 22 USDC
    minPremiumBpsPerDay: 10,
    maxExpirySecs: 30 * 86400,
    horizonEnd: now + 30 * 86400,
    maxRoundsPerDay: 6,
  });
  const meta = env.send(ixs, [user]);
  console.log("create_plan CU:", meta.computeUnitsConsumed().toString());
  const p = env.decode<any>("plan", plan);
  const [lendAuth] = lendAuthPda(plan);
  const fBal = env.tokenBalance(ata(LEND_MARKETS.USDC.fTokenMint, lendAuth));
  console.log("collateral", p.collateralPrincipal.toString(), "shares", p.lendShares.toString(), "fToken bal", fBal);
  assert.equal(p.collateralPrincipal.toString(), "22000000");
  assert.ok(fBal > 0n);
  assert.equal(p.lendShares.toString(), fBal.toString());
  assert.equal(env.tokenBalance(userUsdc), 1_000_000_000n - 22_000_000n - 10n); // + LEND_DUST_BUFFER

  env.warp(3600);
  const closeIxs = await c.closePlan(user.publicKey, plan, p);
  const m2 = env.send(closeIxs, [user]);
  console.log("close_plan CU:", m2.computeUnitsConsumed().toString());
  const back = env.tokenBalance(userUsdc);
  console.log("user USDC after close:", back, "delta vs start:", back - 1_000_000_000n);
  assert.ok(back >= 1_000_000_000n - 1n, "user got principal back (±1 rounding)");
  assert.equal(env.tokenBalance(ata(LEND_MARKETS.USDC.fTokenMint, lendAuth)), 0n);
  const p2 = env.decode<any>("plan", plan);
  assert.ok("closed" in p2.status);
});

test("Sell plan: WSOL → Jupiter Lend WSOL market from PDA, close returns WSOL", async () => {
  const w = await setupWorld();
  const { env, user } = w;
  const c = env.client;
  const userWsol = env.setTokenBalance(WSOL_MINT, user.publicKey, 0n);
  const now = env.now();
  const { ixs, plan } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 7,
    side: "sell",
    quick: false,
    exitStrike: 150_000_000n,
    sizeTotal: 500_000_000n,
    minPremiumBpsPerDay: 10,
    maxExpirySecs: 30 * 86400,
    horizonEnd: now + 30 * 86400,
    maxRoundsPerDay: 6,
  });
  env.send([...env.wrapIxs(user.publicKey, 500_000_010n), ...ixs], [user]); // size + LEND_DUST_BUFFER
  const p = env.decode<any>("plan", plan);
  console.log("sell plan shares", p.lendShares.toString());
  assert.ok(BigInt(p.lendShares.toString()) > 0n);
  env.warp(600);
  env.send(await c.closePlan(user.publicKey, plan, p), [user]);
  const back = env.tokenBalance(userWsol);
  console.log("WSOL back", back);
  assert.ok(back >= 500_000_000n);
});
