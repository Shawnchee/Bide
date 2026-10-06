// Regression tests for codex.md (canonical vault / destination binding) + z_review P-M3 / P-L2.
// Attack model: anyone can create a NON-ATA token account whose token authority is a Bide PDA (no PDA signature
// needed) and pass it in place of the canonical vault. Every such substitution must fail with InvalidAccount, leaving
// program state and the real balances untouched; the canonical (shared-client) path must still pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ACCOUNT_SIZE, createInitializeAccount3Instruction } from "@solana/spl-token";
import {
  ata, escrowPda, lendAuthPda, lendAltAddresses, windowStart, LEND_MARKETS, PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, WSOL_MINT,
} from "@bide/shared";
import { setupWorld, shiftPushFeed, SOL_FEED, World } from "./fixtures.js";
import { cloneSample, createQuickBuyPlan, fundMaker, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

const POOL = { maxPremiumBpsOfNotional: 150, maxOpenNotional: 1_000_000_000n, maxUtilizationBps: 8000, spendWindowSecs: 86400, spendWindowCap: 100_000_000n };
const USDC_F = LEND_MARKETS.USDC.fTokenMint;
const WSOL_F = LEND_MARKETS.WSOL.fTokenMint;

/** Attacker creates a fresh (non-ATA) token account of `mint` with `authority` (a Bide PDA) as owner. Real txs. */
function fakeVault(w: World, mint: PublicKey, authority: PublicKey): PublicKey {
  const { env } = w;
  const attacker = env.newWallet(1);
  const acc = Keypair.generate();
  const lamports = Number(env.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE)));
  env.send(
    [
      SystemProgram.createAccount({ fromPubkey: attacker.publicKey, newAccountPubkey: acc.publicKey, lamports, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(acc.publicKey, mint, authority),
    ],
    [attacker, acc],
  );
  assert.ok(!acc.publicKey.equals(ata(mint, authority)));
  return acc.publicKey;
}

/** Replace `from` with `to` in the Bide instruction(s) only (pre-instructions like idempotent ATA creates untouched). */
function swap(ixs: TransactionInstruction[], from: PublicKey, to: PublicKey): TransactionInstruction[] {
  let n = 0;
  const out = ixs.map((ix) => {
    if (!ix.programId.equals(PROGRAM_ID)) return ix;
    const keys = ix.keys.map((k) => {
      if (!k.pubkey.equals(from)) return k;
      n++;
      return { ...k, pubkey: to };
    });
    return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
  });
  assert.ok(n > 0, `key ${from.toBase58()} not in the Bide instruction`);
  return out;
}

/** Raw bytes of state accounts + balances of token accounts; must be identical before/after a rejected tx. */
function snap(w: World, state: PublicKey[], tokens: PublicKey[]) {
  return JSON.stringify({
    s: state.map((k) => w.env.getData(k)?.toString("hex") ?? null),
    t: tokens.map((k) => w.env.tokenBalance(k).toString()),
  });
}

/** Expect InvalidAccount and no state/balance change. */
function rejects(w: World, ixs: TransactionInstruction[], signers: Keypair[], state: PublicKey[], tokens: PublicKey[], useAlt = false) {
  const before = snap(w, state, tokens);
  w.env.expectFail(ixs, signers, "InvalidAccount", useAlt);
  assert.equal(snap(w, state, tokens), before, "state and balances unchanged");
}

async function poolWorld() {
  const w = await setupWorld();
  fundMaker(w, w.maker);
  const { env, admin } = w;
  const c = env.client;
  env.send(await c.initPool(admin.publicKey, POOL), [admin]);
  env.setTokenBalance(USDC_MINT, admin.publicKey, 500_000_000n);
  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, 500_000_000n), [admin]);
  env.setTokenBalance(WSOL_MINT, admin.publicKey, 0n);
  env.send([...env.wrapIxs(admin.publicKey, 2_000_000_000n), ...(await c.poolDeposit(admin.publicKey, WSOL_MINT, 2_000_000_000n))], [admin]);
  env.send(await c.poolLend(admin.publicKey, 200_000_000n, true), [admin]);
  return w;
}

/** Plan + round taken by the pool after its window. */
async function poolTakenRound(w: World, plan: PublicKey, strike: bigint, size: bigint) {
  const { env, admin, agent } = w;
  const c = env.client;
  const { epoch, expiry } = await openQuickEpoch(w);
  const o = await openRound(w, plan, epoch, expiry, { strike, size });
  env.send([o.ix], [agent]);
  env.warp(41);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  return { o, epoch, expiry, take: () => c.poolTakeRound(admin.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey) };
}

test("codex 1: pool deposit / withdraw / lend / unlend reject substitute pool vaults", async () => {
  const w = await poolWorld();
  const { env, admin, agent } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  const fU = fakeVault(w, USDC_MINT, pa.poolAuth);
  const fW = fakeVault(w, WSOL_MINT, pa.poolAuth);
  const fF = fakeVault(w, USDC_F, pa.poolAuth);
  const lp = env.newWallet(5);
  env.setTokenBalance(USDC_MINT, lp.publicKey, 100_000_000n);
  const st = [pa.pool, pa.shareMint];
  const tk = [pa.poolUsdc, pa.poolWsol, pa.poolFToken, ata(USDC_MINT, lp.publicKey)];
  shiftPushFeed(env, SOL_FEED, env.now() - 5);

  // deposit: an empty substitute hid pool assets from NAV → over-minted shares (the codex exploit)
  const dep = await c.poolDeposit(lp.publicKey, USDC_MINT, 100_000_000n);
  rejects(w, swap(dep, pa.poolUsdc, fU), [lp], st, tk);
  rejects(w, swap(dep, pa.poolWsol, fW), [lp], st, tk);
  env.send(dep, [lp]); // canonical path
  const lpShares = env.tokenBalance(ata(pa.shareMint, lp.publicKey));
  // NAV/supply ≈ 1 here: 100 USDC buys ≈ 100 shares (an empty substitute USDC vault would have priced them ~2×)
  assert.ok(lpShares > 99_000_000n && lpShares < 101_000_000n, `fair share price, got ${lpShares}`);

  // withdraw
  const tk2 = [...tk, ata(pa.shareMint, lp.publicKey)];
  const wd = await c.poolWithdraw(lp.publicKey, lpShares);
  rejects(w, swap(wd, pa.poolUsdc, fU), [lp], st, tk2);
  rejects(w, swap(wd, pa.poolWsol, fW), [lp], st, tk2);
  rejects(w, swap(wd, pa.poolFToken, fF), [lp], st, tk2);
  env.send(wd, [lp]);
  assert.equal(env.tokenBalance(ata(pa.shareMint, lp.publicKey)), 0n);

  // lend idle / unlend
  const li = await c.poolLend(admin.publicKey, 10_000_000n, true);
  rejects(w, swap(li, pa.poolUsdc, fU), [admin], st, tk);
  rejects(w, swap(li, pa.poolFToken, fF), [admin], st, tk);
  env.send(li, [admin]);
  const ul = await c.poolLend(agent.publicKey, 10_000_000n, false);
  rejects(w, swap(ul, pa.poolUsdc, fU), [agent], st, tk);
  rejects(w, swap(ul, pa.poolFToken, fF), [agent], st, tk);
  env.send(ul, [agent]);
});

test("codex 1+3: pool_take_round, resolve / unwind / withdraw_collateral reject substitute pool + plan vaults", async () => {
  const w = await poolWorld();
  const { env, admin, agent } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  const fU = fakeVault(w, USDC_MINT, pa.poolAuth);
  const fW = fakeVault(w, WSOL_MINT, pa.poolAuth);
  const spot = realSpotUsdc(w);
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const size = 200_000_000n;
  const plan = await createQuickBuyPlan(w, strike, size * 3n);
  const [lendAuth] = lendAuthPda(plan);
  const ptk = [pa.poolUsdc, pa.poolWsol, pa.poolFToken];

  // A: pool_take_round with substitutes → rejected; canonical take; not exercised → resolve with substitute maker_dest
  const A = await poolTakenRound(w, plan, strike, size);
  rejects(w, swap(await A.take(), pa.poolUsdc, fU), [admin], [pa.pool, plan, A.o.round], [...ptk, escrowPda(A.o.round)[0]]);
  rejects(w, swap(await A.take(), pa.poolWsol, fW), [admin], [pa.pool, plan, A.o.round], [...ptk, escrowPda(A.o.round)[0]]);
  env.send(await A.take(), [admin]);
  await sampleQuickEpoch(w, A.epoch, A.expiry, { num: 110n, den: 100n }); // +10% → put not exercised
  env.setTime(A.expiry);
  env.send([await c.resolveEpoch(A.epoch)], [agent]);
  const resA = await c.resolveRound(agent.publicKey, A.o.round, env.decode<any>("round", A.o.round), env.decode<any>("plan", plan));
  rejects(w, swap(resA, pa.poolWsol, fW), [agent], [pa.pool, plan, A.o.round], [...ptk, escrowPda(A.o.round)[0], fW]);
  const w0 = env.tokenBalance(pa.poolWsol);
  env.send(resA, [agent]);
  assert.equal(env.tokenBalance(pa.poolWsol) - w0, size, "escrow back to the canonical pool vault");
  assert.equal(env.decode<any>("pool", pa.pool).reservedWsol.toString(), "0");

  // B: Failed epoch → unwind with substitute maker_dest
  const B = await poolTakenRound(w, plan, strike, size);
  env.send(await B.take(), [admin]);
  env.setTime(B.expiry + 120);
  env.send([await c.resolveEpoch(B.epoch)], [agent]);
  const unw = await c.unwindRound(agent.publicKey, B.o.round, env.decode<any>("round", B.o.round), env.decode<any>("plan", plan));
  rejects(w, swap(unw, pa.poolWsol, fW), [agent], [pa.pool, plan, B.o.round], [...ptk, escrowPda(B.o.round)[0], fW]);
  env.send(unw, [agent]);
  assert.equal(env.decode<any>("pool", pa.pool).reservedWsol.toString(), "0");

  // C: exercised → withdraw_collateral with substitute counterparty_dest / vault_staging / vault_f_token
  const C = await poolTakenRound(w, plan, strike, size);
  env.send(await C.take(), [admin]);
  await sampleQuickEpoch(w, C.epoch, C.expiry, { num: 90n, den: 100n });
  env.setTime(C.expiry);
  env.send([await c.resolveEpoch(C.epoch)], [agent]);
  env.send(await c.resolveRound(agent.publicKey, C.o.round, env.decode<any>("round", C.o.round), env.decode<any>("plan", plan)), [agent]);
  const fStage = fakeVault(w, USDC_MINT, lendAuth);
  const fPlanF = fakeVault(w, USDC_F, lendAuth);
  const wc = await c.withdrawCollateral(agent.publicKey, C.o.round, env.decode<any>("round", C.o.round), env.decode<any>("plan", plan));
  const st = [pa.pool, plan, C.o.round];
  const tk = [...ptk, ata(USDC_MINT, lendAuth), ata(USDC_F, lendAuth), fU, fStage, fPlanF];
  rejects(w, swap(wc, pa.poolUsdc, fU), [agent], st, tk);
  rejects(w, swap(wc, ata(USDC_MINT, lendAuth), fStage), [agent], st, tk);
  rejects(w, swap(wc, ata(USDC_F, lendAuth), fPlanF), [agent], st, tk);
  const u0 = env.tokenBalance(pa.poolUsdc);
  env.send(wc, [agent]);
  assert.equal(env.tokenBalance(pa.poolUsdc) - u0, C.o.notional, "pool paid into its canonical USDC vault");
  assert.equal(env.decode<any>("pool", pa.pool).reservedUsdc.toString(), "0");
});

test("codex 2: close_plan / expire_plan / update_plan reject substitute plan vaults (incl. empty fToken)", async () => {
  const w = await setupWorld();
  const { env, user } = w;
  const c = env.client;
  const plan = await createQuickBuyPlan(w, 100_000_000n, 200_000_000n);
  const [lendAuth] = lendAuthPda(plan);
  const vc = ata(USDC_MINT, lendAuth);
  const vf = ata(USDC_F, lendAuth);
  const fC = fakeVault(w, USDC_MINT, lendAuth);
  const fF = fakeVault(w, USDC_F, lendAuth); // empty: pre-fix this skipped redemption and closed the plan
  const ownerU = ata(USDC_MINT, user.publicKey);
  const tk = [vc, vf, ownerU, fC, fF];

  // update_plan (owner): rebalance path
  const up = await c.updatePlan(user.publicKey, plan, env.decode<any>("plan", plan), { sizeTotal: 400_000_000n });
  rejects(w, swap(up, vc, fC), [user], [plan], tk);
  rejects(w, swap(up, vf, fF), [user], [plan], tk);
  env.send(up, [user]);

  // close_plan (owner)
  const cl = await c.closePlan(user.publicKey, plan, env.decode<any>("plan", plan));
  rejects(w, swap(cl, vc, fC), [user], [plan], tk);
  rejects(w, swap(cl, vf, fF), [user], [plan], tk);

  // expire_plan (anyone, after horizon)
  env.setTime(Number(env.decode<any>("plan", plan).horizonEnd) + 1);
  const stranger = env.newWallet(1);
  const ex = await c.closePlan(stranger.publicKey, plan, env.decode<any>("plan", plan), true);
  rejects(w, swap(ex, vc, fC), [stranger], [plan], tk);
  rejects(w, swap(ex, vf, fF), [stranger], [plan], tk);
  assert.ok("active" in env.decode<any>("plan", plan).status, "plan still open");
  const f0 = env.tokenBalance(vf);
  assert.ok(f0 > 0n);
  const u0 = env.tokenBalance(ownerU);
  env.send(ex, [stranger]);
  assert.ok("closed" in env.decode<any>("plan", plan).status);
  assert.equal(env.tokenBalance(vf), 0n, "real Lend position redeemed");
  assert.ok(env.tokenBalance(ownerU) - u0 >= 40_000_000n, "collateral returned to owner");

  // create_plan with a substitute fToken vault (owner-only, but bound the same way)
  const { ixs, plan: plan2 } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 2, side: "buy", quick: true, targetStrike: 100_000_000n, sizeTotal: 200_000_000n,
    minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 2 * 86400, maxRoundsPerDay: 30,
  });
  const [la2] = lendAuthPda(plan2);
  const fF2 = fakeVault(w, USDC_F, la2);
  env.expectFail(swap(ixs, ata(USDC_F, la2), fF2), [user], "InvalidAccount");
  assert.ok(!env.exists(plan2));
  env.send(ixs, [user]);
});

test("codex 2+3: Wheel — put delivery, close (asset vault) and flip_plan reject substitutes", async () => {
  const w = await setupWorld();
  const { env, agent, maker, user } = w;
  const c = env.client;
  fundMaker(w, maker);
  env.installAlt(lendAltAddresses());
  const spot = realSpotUsdc(w);
  const target = (spot / 100_000n - 20n) * 100_000n;
  const exit = (spot / 100_000n + 20n) * 100_000n;
  const size = 200_000_000n;
  env.setTokenBalance(USDC_MINT, user.publicKey, 1_000_000_000n);
  const { ixs, plan } = await c.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 31, side: "wheel", quick: true, targetStrike: target, exitStrike: exit, sizeTotal: size,
    minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 3 * 86400, maxRoundsPerDay: 30,
  });
  env.send(ixs, [user]);
  const [lendAuth] = lendAuthPda(plan);
  const va = ata(WSOL_MINT, lendAuth);
  const fA = fakeVault(w, WSOL_MINT, lendAuth);

  const { epoch, expiry } = await openQuickEpoch(w);
  const o = await openRound(w, plan, epoch, expiry, { strike: target, size });
  env.send([o.ix], [agent]);
  env.warp(5);
  env.send(await c.takeRound(maker.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), w.feeRecipient.publicKey), [maker]);
  await sampleQuickEpoch(w, epoch, expiry, { num: 90n, den: 100n });
  env.setTime(expiry);
  env.send([await c.resolveEpoch(epoch)], [agent]);
  // exercised Wheel put: delivery must land in the canonical asset vault
  const res = await c.resolveRound(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan));
  rejects(w, swap(res, va, fA), [agent], [plan, o.round], [va, fA, escrowPda(o.round)[0]]);
  env.send(res, [agent]);
  assert.equal(env.tokenBalance(va), size);
  env.send(await c.withdrawCollateral(agent.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan)), [agent]);

  // close in Accumulate with a substitute (empty) asset vault
  const vu = ata(USDC_MINT, lendAuth);
  const vuf = ata(USDC_F, lendAuth);
  const tk = [va, vu, vuf, fA, ata(USDC_MINT, user.publicKey), ata(WSOL_MINT, user.publicKey)];
  const cl = await c.closePlan(user.publicKey, plan, env.decode<any>("plan", plan));
  rejects(w, swap(cl, va, fA), [user], [plan], tk);

  // flip_plan: each plan vault substituted
  const fU = fakeVault(w, USDC_MINT, lendAuth);
  const fUF = fakeVault(w, USDC_F, lendAuth);
  const fAF = fakeVault(w, WSOL_F, lendAuth);
  const fl = await c.flipPlan(agent.publicKey, plan, env.decode<any>("plan", plan));
  const tk2 = [...tk, ata(WSOL_F, lendAuth), fU, fUF, fAF];
  rejects(w, swap(fl, vu, fU), [agent], [plan], tk2, true);
  rejects(w, swap(fl, vuf, fUF), [agent], [plan], tk2, true);
  rejects(w, swap(fl, va, fA), [agent], [plan], tk2, true);
  rejects(w, swap(fl, ata(WSOL_F, lendAuth), fAF), [agent], [plan], tk2, true);
  env.send(fl, [agent], true);
  assert.ok("exit" in env.decode<any>("plan", plan).phase);
});

test("z P-M3: withdraw_collateral shortfall pays what the plan holds and logs the deficit", async () => {
  const w = await poolWorld();
  const { env, admin, agent } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  const spot = realSpotUsdc(w);
  const strike = (spot / 100_000n - 30n) * 100_000n;
  const size = 200_000_000n;
  const plan = await createQuickBuyPlan(w, strike, size);
  const C = await poolTakenRound(w, plan, strike, size);
  env.send(await C.take(), [admin]);
  await sampleQuickEpoch(w, C.epoch, C.expiry, { num: 90n, den: 100n });
  env.setTime(C.expiry);
  env.send([await c.resolveEpoch(C.epoch)], [agent]);
  env.send(await c.resolveRound(agent.publicKey, C.o.round, env.decode<any>("round", C.o.round), env.decode<any>("plan", plan)), [agent]);
  assert.equal(env.decode<any>("pool", pa.pool).reservedUsdc.toString(), C.o.notional.toString());
  // simulate a Lend loss: the plan's position is worth ~half of what it owes
  const [lendAuth] = lendAuthPda(plan);
  env.setTokenBalance(USDC_F, lendAuth, env.tokenBalance(ata(USDC_F, lendAuth)) / 2n);
  const u0 = env.tokenBalance(pa.poolUsdc);
  const res = env.send(await c.withdrawCollateral(agent.publicKey, C.o.round, env.decode<any>("round", C.o.round), env.decode<any>("plan", plan)), [agent]);
  const paid = env.tokenBalance(pa.poolUsdc) - u0;
  assert.ok(paid > 0n && paid < C.o.notional, "partial payment");
  const log = res.logs().find((l) => l.includes("collateral shortfall"));
  assert.ok(log, "deficit logged");
  assert.ok(log!.includes(`deficit=${C.o.notional - paid}`), log);
  // the round is closed, so the unpaid part is uncollectable: the receivable is written off (realized loss in NAV)
  assert.equal(env.decode<any>("pool", pa.pool).reservedUsdc.toString(), "0");
  assert.equal(env.decode<any>("plan", plan).pendingSettlement, null);
});

test("z P-L2: post_sample rejects a sample whose publish_time is in the future", async () => {
  const w = await setupWorld();
  const { env, admin } = w;
  const { epoch, expiry } = await openQuickEpoch(w);
  const ws = windowStart(expiry, "Quick");
  env.setTime(ws - 5); // bucket 0 starts in 5 s; a sample stamped at its start is from the future
  env.expectFail([await env.client.postSample(WSOL_MINT, epoch, cloneSample(w, ws), 0)], [admin], "SampleOutsideBucket");
  env.setTime(ws);
  env.send([await env.client.postSample(WSOL_MINT, epoch, cloneSample(w, ws), 0)], [admin]);
});
