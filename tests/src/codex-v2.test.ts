// codex_v2.md reproductions turned into regression tests.
// P1: pool NAV marks live pool-held options at intrinsic value (SPEC decision 2026-10-07), so an LP can't mint
//     shares after resolve_epoch and before resolve_round at a stale NAV and redeem after the payoff is booked.
//     Run this file with BIDE_SO=<pre-fix bide.so> to see the P1 attack tests fail with the attacker's profit.
// P2: the program needs size + 10 lamports wrapped for a WSOL Sell plan.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { ata, notionalFloor, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { setupWorld, shiftPushFeed, SOL_FEED, World } from "./fixtures.js";
import { createQuickBuyPlan, openQuickEpoch, openRound, realSpotUsdc, sampleQuickEpoch } from "./flows.js";

const PARAMS = { maxPremiumBpsOfNotional: 150, maxOpenNotional: 1_000_000_000n, maxUtilizationBps: 8000, spendWindowSecs: 86400, spendWindowCap: 100_000_000n };
const LP_USDC = 500_000_000n;
const LP_SOL = 2_000_000_000n;
const SIZE = 200_000_000n;
type Mul = { num: bigint; den: bigint };
type Kind = "put" | "call";

test("review P2: wrapping the app's exact sell amount fails without the program's 10-lamport buffer", async () => {
  const w = await setupWorld();
  const { env, user } = w;
  env.setTokenBalance(WSOL_MINT, user.publicKey, 0n);
  const size = 300_000_000n;
  const { ixs } = await env.client.createPlan(user.publicKey, WSOL_MINT, {
    nonce: 101, side: "sell", quick: true, exitStrike: 150_000_000n, sizeTotal: size,
    minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 86400, maxRoundsPerDay: 30,
  });
  env.expectFail([...env.wrapIxs(user.publicKey, size), ...ixs], [user], "insufficient funds");
  env.send([...env.wrapIxs(user.publicKey, size + 10n), ...ixs], [user]);
});

// ---------- helpers ----------

/** init_pool + the admin LP deposits 500 USDC and 2 SOL. */
async function seedPool(w: World) {
  const { env, admin } = w;
  const c = env.client;
  env.send(await c.initPool(admin.publicKey, PARAMS), [admin]);
  env.setTokenBalance(USDC_MINT, admin.publicKey, LP_USDC);
  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, LP_USDC), [admin]);
  env.setTokenBalance(WSOL_MINT, admin.publicKey, 0n);
  env.send([...env.wrapIxs(admin.publicKey, LP_SOL), ...(await c.poolDeposit(admin.publicKey, WSOL_MINT, LP_SOL))], [admin]);
}

/** Opens a quick round (Buy plan → Put, Sell plan → Call) and lets the pool take it after the pool window. */
async function poolTakenRound(w: World, kind: Kind, strike: bigint) {
  const { env, admin, agent, user, feeRecipient } = w;
  const c = env.client;
  const { epoch, expiry } = await openQuickEpoch(w);
  let plan: PublicKey;
  if (kind === "put") {
    plan = await createQuickBuyPlan(w, strike, SIZE);
  } else {
    env.setTokenBalance(WSOL_MINT, user.publicKey, 0n);
    const r = await c.createPlan(user.publicKey, WSOL_MINT, {
      nonce: 7, side: "sell", quick: true, exitStrike: strike, sizeTotal: SIZE,
      minPremiumBpsPerDay: 10, maxExpirySecs: 86400, horizonEnd: env.now() + 2 * 86400, maxRoundsPerDay: 30,
    });
    env.send([...env.wrapIxs(user.publicKey, SIZE + 10n), ...r.ixs], [user]);
    plan = r.plan;
  }
  const o = await openRound(w, plan, epoch, expiry, { strike, size: SIZE });
  env.send([o.ix], [agent]);
  env.warp(41);
  shiftPushFeed(env, SOL_FEED, env.now() - 5);
  env.send(await c.poolTakeRound(admin.publicKey, o.round, env.decode<any>("round", o.round), env.decode<any>("plan", plan), env.decode<any>("asset", w.asset), feeRecipient.publicKey), [admin]);
  const r = env.decode<any>("round", o.round);
  return { plan, round: o.round, epoch, expiry, notional: o.notional, premium: BigInt(r.premiumPaid.toString()) };
}

/** Resolve the epoch at settle = real price × mul, then move spot to the same price (spot == settle). */
async function settleAt(w: World, epoch: PublicKey, expiry: number, mul: Mul) {
  const { env, admin } = w;
  await sampleQuickEpoch(w, epoch, expiry, mul);
  env.setTime(expiry);
  env.send([await env.client.resolveEpoch(epoch)], [admin]);
  shiftPushFeed(env, SOL_FEED, env.now() - 1, mul);
}

const big = (x: { toString(): string }) => BigInt(x.toString());
const solValue = (spot: bigint, lamports: bigint) => notionalFloor(spot, lamports, 9);

/** Mirror of pool_nav (no Lend: these tests park nothing in Lend). */
function nav(w: World): bigint {
  const { env } = w;
  const pa = env.client.poolAccounts();
  const p = env.decode<any>("pool", pa.pool);
  const spot = realSpotUsdc(w);
  const putSize = big(p.putOpenSize), putNotional = big(p.putOpenNotional);
  const callNotional = big(p.callOpenNotional), callSize = big(p.callOpenSize);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const reserved =
    max(solValue(spot, putSize), putNotional) +
    max(callNotional, solValue(spot, callSize)) +
    (big(p.reservedUsdc) - callNotional) +
    solValue(spot, big(p.reservedWsol) - putSize);
  return env.tokenBalance(pa.poolUsdc) + solValue(spot, env.tokenBalance(pa.poolWsol)) + reserved;
}

/** Value (USDC base units, at current spot) of what `who` holds in USDC + WSOL. */
function walletValue(w: World, who: PublicKey) {
  return w.env.tokenBalance(ata(USDC_MINT, who)) + solValue(realSpotUsdc(w), w.env.tokenBalance(ata(WSOL_MINT, who)));
}

/**
 * The P1 attack: after resolve_epoch (outcome public) and before resolve_round, a fresh LP deposits USDC, then
 * permissionlessly resolves the round + withdraws collateral, then redeems all its shares. Returns profit.
 */
async function attack(kind: Kind, strikeOffsetTicks: bigint, mul: Mul) {
  const w = await setupWorld();
  const { env } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  await seedPool(w);
  const spot0 = realSpotUsdc(w);
  const strike = (spot0 / 100_000n + strikeOffsetTicks) * 100_000n;
  const t = await poolTakenRound(w, kind, strike);
  await settleAt(w, t.epoch, t.expiry, mul);

  const attacker = env.newWallet(10);
  const deposit = LP_USDC;
  env.setTokenBalance(USDC_MINT, attacker.publicKey, deposit);
  env.setTokenBalance(WSOL_MINT, attacker.publicKey, 0n);
  env.send(await c.poolDeposit(attacker.publicKey, USDC_MINT, deposit), [attacker]);
  env.send(await c.resolveRound(attacker.publicKey, t.round, env.decode<any>("round", t.round), env.decode<any>("plan", t.plan)), [attacker]);
  env.send(await c.withdrawCollateral(attacker.publicKey, t.round, env.decode<any>("round", t.round), env.decode<any>("plan", t.plan)), [attacker]);
  const shares = env.tokenBalance(ata(pa.shareMint, attacker.publicKey));
  shiftPushFeed(env, SOL_FEED, env.now() - 1);
  env.send(await c.poolWithdraw(attacker.publicKey, shares), [attacker]);
  const value = walletValue(w, attacker.publicKey);
  return { profit: value - deposit, deposit };
}

// ---------- P1: the attack is no longer profitable ----------

test("P1: LP depositing after resolve_epoch, before resolve_round (exercised pool PUT) gains nothing", async () => {
  // strike $3 under spot, settle at half spot → deep ITM for the pool (it receives strike notional for SOL at ½ spot)
  const { profit, deposit } = await attack("put", -30n, { num: 1n, den: 2n });
  console.log("P1 put: attacker profit (USDC base units):", String(profit));
  // pre-fix binary: +5_072_526 (≈ +5.07 USDC on a 500 USDC deposit, taken from the existing LP)
  assert.ok(profit <= 0n, `attacker profited ${profit} on ${deposit}`);
  assert.ok(profit > -1_000n, `attacker lost more than rounding: ${profit}`);
});

test("P1: same window for an exercised pool CALL gains nothing", async () => {
  // strike $5 over spot, settle at 2× spot → the pool receives SOL worth ~2× the USDC it escrowed
  const { profit, deposit } = await attack("call", 50n, { num: 2n, den: 1n });
  // pre-fix binary: +7_753_280
  console.log("P1 call: attacker profit (USDC base units):", String(profit));
  assert.ok(profit <= 0n, `attacker profited ${profit} on ${deposit}`);
  assert.ok(profit > -1_000n, `attacker lost more than rounding: ${profit}`);
});

// ---------- normal path: NAV accounting across every outcome ----------

type Outcome = "put-exercised" | "put-not-exercised" | "call-exercised" | "call-not-exercised" | "unwind";
const CASES: { name: Outcome; kind: Kind; strikeTicks: bigint; mul: Mul | null; exercised: boolean }[] = [
  { name: "put-exercised", kind: "put", strikeTicks: -30n, mul: { num: 1n, den: 2n }, exercised: true },
  { name: "put-not-exercised", kind: "put", strikeTicks: -30n, mul: { num: 1n, den: 1n }, exercised: false },
  { name: "call-exercised", kind: "call", strikeTicks: 50n, mul: { num: 2n, den: 1n }, exercised: true },
  { name: "call-not-exercised", kind: "call", strikeTicks: 50n, mul: { num: 1n, den: 1n }, exercised: false },
  { name: "unwind", kind: "put", strikeTicks: -30n, mul: null, exercised: false },
];

for (const k of CASES) {
  test(`pool NAV accounting consistent: ${k.name}; deposit/withdraw work`, async () => {
    const w = await setupWorld();
    const { env, admin } = w;
    const c = env.client;
    const pa = c.poolAccounts();
    await seedPool(w);
    const spot0 = realSpotUsdc(w);
    const strike = (spot0 / 100_000n + k.strikeTicks) * 100_000n;
    const nav0 = nav(w);
    const t = await poolTakenRound(w, k.kind, strike);
    const dec = () => env.decode<any>("pool", pa.pool);
    let p = dec();

    // take books the per-kind open sums
    if (k.kind === "put") {
      assert.equal(big(p.putOpenSize), SIZE);
      assert.equal(big(p.putOpenNotional), t.notional);
      assert.equal(big(p.reservedWsol), SIZE);
    } else {
      assert.equal(big(p.callOpenNotional), t.notional);
      assert.equal(big(p.callOpenSize), SIZE);
      assert.equal(big(p.reservedUsdc), t.notional);
    }
    // OTM at take: the leg is worth the escrow, so the take only costs the premium (±1 rounding)
    const navTaken = nav(w);
    assert.ok(nav0 - t.premium - navTaken <= 1n && nav0 - t.premium - navTaken >= -1n, `take: ${nav0} − ${t.premium} vs ${navTaken}`);

    // a normal LP deposit/withdraw while the round is live: no value created or destroyed beyond rounding
    const lp = env.newWallet(10);
    env.setTokenBalance(USDC_MINT, lp.publicKey, 100_000_000n);
    env.setTokenBalance(WSOL_MINT, lp.publicKey, 0n);
    env.send(await c.poolDeposit(lp.publicKey, USDC_MINT, 100_000_000n), [lp]);
    env.send(await c.poolWithdraw(lp.publicKey, env.tokenBalance(ata(pa.shareMint, lp.publicKey))), [lp]);
    const lpValue = walletValue(w, lp.publicKey);
    assert.ok(lpValue <= 100_000_000n && lpValue > 100_000_000n - 1_000n, `live-round round trip: ${lpValue}`);

    const usdc0 = env.tokenBalance(pa.poolUsdc), wsol0 = env.tokenBalance(pa.poolWsol);
    if (k.mul) {
      await settleAt(w, t.epoch, t.expiry, k.mul);
      const navResolved = nav(w); // after resolve_epoch, before resolve_round: marked at intrinsic
      env.send(await c.resolveRound(admin.publicKey, t.round, env.decode<any>("round", t.round), env.decode<any>("plan", t.plan)), [admin]);
      const navRR = nav(w);
      assert.ok(navRR - navResolved <= 1n && navResolved - navRR <= 1n, `resolve_round moved NAV: ${navResolved} → ${navRR}`);
      if (k.exercised) {
        env.send(await c.withdrawCollateral(admin.publicKey, t.round, env.decode<any>("round", t.round), env.decode<any>("plan", t.plan)), [admin]);
        const navWC = nav(w);
        assert.ok(navWC - navRR <= 1n && navRR - navWC <= 1n, `withdraw_collateral moved NAV: ${navRR} → ${navWC}`);
      }
    } else {
      env.setTime(t.expiry + 120);
      env.send([await c.resolveEpoch(t.epoch)], [admin]);
      env.send(await c.unwindRound(admin.publicKey, t.round, env.decode<any>("round", t.round), env.decode<any>("plan", t.plan)), [admin]);
    }

    // everything released; vaults moved by exactly the round's payoff
    p = dec();
    for (const f of ["reservedUsdc", "reservedWsol", "openNotional", "putOpenSize", "putOpenNotional", "callOpenNotional", "callOpenSize"]) {
      assert.equal(big(p[f]), 0n, `${f} not released`);
    }
    const dU = env.tokenBalance(pa.poolUsdc) - usdc0, dW = env.tokenBalance(pa.poolWsol) - wsol0;
    const want =
      k.kind === "put"
        ? k.exercised ? [t.notional, 0n] : [0n, SIZE]
        : k.exercised ? [0n, SIZE] : [t.notional, 0n];
    assert.deepEqual([dU, dW], want, `vault deltas for ${k.name}`);

    // the original LP redeems at the final NAV. 99.9% of its shares, not 100%: with the virtual-share offset a full
    // redemption is refused (InsufficientFreeFunds) once NAV/share < 1 (pre-existing, ≤ POOL_VIRTUAL_OFFSET units).
    shiftPushFeed(env, SOL_FEED, env.now() - 1);
    const navEnd = nav(w);
    env.setTokenBalance(USDC_MINT, admin.publicKey, 0n);
    env.setTokenBalance(WSOL_MINT, admin.publicKey, 0n);
    env.send(await c.poolWithdraw(admin.publicKey, (env.tokenBalance(ata(pa.shareMint, admin.publicKey)) * 999n) / 1000n), [admin]);
    const got = walletValue(w, admin.publicKey);
    const fair = (navEnd * 999n) / 1000n;
    assert.ok(got <= fair + 1_000n && fair - got < fair / 100_000n + 10n, `LP redeemed ${got}, fair ${fair} (NAV ${navEnd})`);
  });
}

// ---------- migrate_pool ----------

test("migrate_pool grows a v1 Pool account (admin only, one-shot); pool instructions work after", async () => {
  const w = await setupWorld();
  const { env, admin, user } = w;
  const c = env.client;
  const pa = c.poolAccounts();
  env.send(await c.initPool(admin.publicKey, PARAMS), [admin]);
  // simulate the devnet v1 account: same bytes, truncated to the v1 length (148), v1 rent
  const full = env.getData(pa.pool)!;
  assert.equal(full.length, 180);
  const v1 = Buffer.from(full.subarray(0, 148));
  env.setRaw(pa.pool, v1, c.programId);
  env.setTokenBalance(USDC_MINT, admin.publicKey, LP_USDC);
  env.expectFail(await c.poolDeposit(admin.publicKey, USDC_MINT, LP_USDC), [admin], "AccountDidNotDeserialize");

  env.expectFail([await c.migratePool(user.publicKey)], [user], "Unauthorized");
  env.send([await c.migratePool(admin.publicKey)], [admin]);
  const d = env.getData(pa.pool)!;
  assert.equal(d.length, 180);
  assert.ok(d.subarray(0, 148).equals(v1), "v1 bytes preserved");
  assert.ok(d.subarray(148).every((b) => b === 0), "v2 fields zero");
  const p = env.decode<any>("pool", pa.pool);
  assert.equal(p.authority.toBase58(), admin.publicKey.toBase58());
  assert.equal(big(p.putOpenSize) + big(p.putOpenNotional) + big(p.callOpenNotional) + big(p.callOpenSize), 0n);
  env.expectFail([await c.migratePool(admin.publicKey)], [admin], "WrongStatus");

  env.send(await c.poolDeposit(admin.publicKey, USDC_MINT, LP_USDC), [admin]);
  assert.equal(env.tokenBalance(ata(pa.shareMint, admin.publicKey)), LP_USDC);
});
