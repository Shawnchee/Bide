// Shared flow helpers for loop tests.
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ata, epochPda, roundPda, minPremiumFloor, notionalFloor, nextQuickExpiry, EPOCH_PARAMS,
  PYTH_RECEIVER_PROGRAM_ID, USDC_MINT, WSOL_MINT, windowStart,
} from "@bide/shared";
import { World, SOL_FEED, shiftPushFeed, readPriceUpdate, priceUpdateOffsets } from "./fixtures.js";

/** Real SOL/USD price (USDC units) from the dumped push feed. */
export function realSpotUsdc(w: World): bigint {
  const pu = readPriceUpdate(w.env.getData(SOL_FEED)!);
  const e = 6 + pu.expo;
  return e >= 0 ? pu.price * 10n ** BigInt(e) : pu.price / 10n ** BigInt(-e);
}

/**
 * Fixture adjustment: clone the REAL push-feed PriceUpdateV2 bytes into a new account with publish_time `t`
 * (optionally a scaled price). Used to exercise post_sample's account validation on LiteSVM.
 */
export function cloneSample(w: World, t: number, priceMul?: { num: bigint; den: bigint }, opts: { partial?: boolean; feedIdHex?: string; confMul?: bigint } = {}): PublicKey {
  const d = Buffer.from(w.env.getData(SOL_FEED)!);
  const o = priceUpdateOffsets(d);
  d.writeBigInt64LE(BigInt(t), o.publishTime);
  d.writeBigInt64LE(BigInt(t - 1), o.prevPublishTime);
  if (priceMul) d.writeBigInt64LE((d.readBigInt64LE(o.price) * priceMul.num) / priceMul.den, o.price);
  if (opts.confMul) d.writeBigUInt64LE(d.readBigUInt64LE(o.conf) * opts.confMul, o.conf);
  if (opts.feedIdHex) Buffer.from(opts.feedIdHex, "hex").copy(d, o.feedId);
  let out = d;
  if (opts.partial && o.verification === 1) {
    // re-encode as Partial{num_signatures: 3}: shift the body by one byte
    out = Buffer.alloc(d.length);
    d.copy(out, 0, 0, 40);
    out[40] = 0;
    out[41] = 3;
    d.copy(out, 42, 41, d.length - 1);
  }
  const pk = Keypair.generate().publicKey;
  w.env.setRaw(pk, out, PYTH_RECEIVER_PROGRAM_ID);
  return pk;
}

export interface QuickPutSetup {
  plan: PublicKey;
  epoch: PublicKey;
  expiry: number;
  round: PublicKey;
  strike: bigint;
  size: bigint;
  notional: bigint;
  floor: bigint;
  start: bigint;
}

export function fundMaker(w: World, maker: Keypair) {
  w.env.setTokenBalance(USDC_MINT, maker.publicKey, 1_000_000_000n);
  w.env.setTokenBalance(WSOL_MINT, maker.publicKey, 5_000_000_000n);
}

/** Opens a quick epoch at the next 10-min boundary and positions the clock inside its auction window. */
export async function openQuickEpoch(w: World): Promise<{ epoch: PublicKey; expiry: number }> {
  const { env, admin } = w;
  const expiry = nextQuickExpiry(env.now()) + 600;
  env.send([await env.client.openEpoch(admin.publicKey, WSOL_MINT, "quick", expiry)], [admin]);
  env.setTime(expiry - 600 + 5);
  shiftPushFeed(env, SOL_FEED, env.now() - 10);
  return { epoch: epochPda(w.asset, 1, expiry)[0], expiry };
}

export async function createQuickBuyPlan(w: World, strike: bigint, size: bigint, nonce = 1, extra: Partial<Record<string, unknown>> = {}) {
  const { env, user } = w;
  if (env.tokenBalance(ata(USDC_MINT, user.publicKey)) === 0n) env.setTokenBalance(USDC_MINT, user.publicKey, 10_000_000_000n);
  const { ixs, plan } = await env.client.createPlan(user.publicKey, WSOL_MINT, {
    nonce,
    side: "buy",
    quick: true,
    targetStrike: strike,
    sizeTotal: size,
    minPremiumBpsPerDay: 10,
    maxExpirySecs: 86400,
    horizonEnd: env.now() + 2 * 86400,
    maxRoundsPerDay: 30,
    ...extra,
  });
  env.send(ixs, [user]);
  return plan;
}

export async function openRound(w: World, plan: PublicKey, epoch: PublicKey, expiry: number, a: { strike: bigint; size: bigint; floor?: bigint; start?: bigint; auctionSecs?: number }) {
  const { env, agent } = w;
  const p = env.decode<any>("plan", plan);
  const asset = env.decode<any>("asset", w.asset);
  const notional = notionalFloor(a.strike, a.size, 9);
  const floor = a.floor ?? minPremiumFloor(1000, notional, 10, expiry - env.now()) + 1000n;
  const start = a.start ?? floor * 2n;
  const ix = await env.client.openRound(agent.publicKey, plan, p, asset, epoch, {
    strike: a.strike,
    size: a.size,
    auctionSecs: a.auctionSecs ?? 30,
    premiumStart: start,
    premiumFloor: floor,
    memoHash: new Uint8Array(32).fill(7),
  });
  return { ix, round: roundPda(plan, p.roundCount)[0], notional, floor, start };
}

/** Post all n samples for a quick epoch with real price bytes (optionally scaled), then move past expiry. */
export async function sampleQuickEpoch(w: World, epoch: PublicKey, expiry: number, priceMul?: { num: bigint; den: bigint }, n: number = EPOCH_PARAMS.Quick.nBuckets) {
  const { env, admin } = w;
  const ws = windowStart(expiry, "Quick");
  for (let b = 0; b < n; b++) {
    const bs = ws + b * EPOCH_PARAMS.Quick.bucketSecs;
    if (env.now() < bs + 1) env.setTime(bs + 1);
    const pu = cloneSample(w, bs, priceMul); // publish_time = bucket start, prev = start − 1
    env.send([await env.client.postSample(WSOL_MINT, epoch, pu, b)], [admin]);
  }
}
