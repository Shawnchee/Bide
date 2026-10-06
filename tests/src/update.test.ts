// update_plan: size up → extra deposit; target down → withdraw excess; bounds re-validated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ata, notionalCeil, USDC_MINT } from "@bide/shared";
import { setupWorld } from "./fixtures.js";
import { createQuickBuyPlan } from "./flows.js";

test("update_plan resizes collateral via Lend and re-checks bounds", async () => {
  const w = await setupWorld();
  const { env, user } = w;
  const c = env.client;
  const plan = await createQuickBuyPlan(w, 100_000_000n, 200_000_000n);
  const u = ata(USDC_MINT, user.publicKey);
  const b0 = env.tokenBalance(u);
  env.send(await c.updatePlan(user.publicKey, plan, env.decode<any>("plan", plan), { sizeTotal: 400_000_000n }), [user]);
  let p = env.decode<any>("plan", plan);
  assert.equal(p.collateralPrincipal.toString(), notionalCeil(100_000_000n, 400_000_000n, 9).toString());
  assert.equal(b0 - env.tokenBalance(u), 20_000_000n, "extra 20 USDC deposited");
  const b1 = env.tokenBalance(u);
  env.send(await c.updatePlan(user.publicKey, plan, p, { targetStrike: 90_000_000n }), [user]);
  p = env.decode<any>("plan", plan);
  assert.equal(p.strikeMax.toString(), "90000000");
  assert.equal(env.tokenBalance(u) - b1, 4_000_000n, "4 USDC withdrawn from Lend back to the owner");
  env.expectFail(await c.updatePlan(user.publicKey, plan, p, { targetStrike: 90_050_000n }), [user], "StrikeOffTick");
  env.expectFail(await c.updatePlan(user.publicKey, plan, p, { horizonEnd: env.now() + 60 }), [user], "HorizonOutOfRange");
  const stranger = env.newWallet(1);
  env.setTokenBalance(USDC_MINT, stranger.publicKey, 1n);
  env.expectFail(await c.updatePlan(stranger.publicKey, plan, p, { minPremiumBpsPerDay: 5 }), [stranger], "Unauthorized");
});
