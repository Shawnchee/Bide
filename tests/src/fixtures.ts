// Common setup: config + SOL asset + funded wallets, and push-feed time shift.
import { Keypair, PublicKey } from "@solana/web3.js";
import { PYTH_FEED_IDS, PYTH_PUSH_FEEDS, PYTH_RECEIVER_PROGRAM_ID, WSOL_MINT, USDC_MINT, configPda, assetPda } from "@bide/shared";
import { Env } from "./harness.js";

export const SOL_FEED = PYTH_PUSH_FEEDS.SOL_USD;

/** PriceUpdateV2 offsets (depends on VerificationLevel variant size). */
export function priceUpdateOffsets(d: Buffer) {
  const v = d[40]; // 0 = Partial{u8}, 1 = Full
  const base = v === 0 ? 42 : 41;
  return { verification: v, feedId: base, price: base + 32, conf: base + 40, expo: base + 48, publishTime: base + 52, prevPublishTime: base + 60 };
}

export function readPriceUpdate(d: Buffer) {
  const o = priceUpdateOffsets(d);
  return {
    full: o.verification === 1,
    feedId: d.subarray(o.feedId, o.feedId + 32).toString("hex"),
    price: d.readBigInt64LE(o.price),
    conf: d.readBigUInt64LE(o.conf),
    expo: d.readInt32LE(o.expo),
    publishTime: Number(d.readBigInt64LE(o.publishTime)),
  };
}

/**
 * Fixture adjustment (documented in notes/program.md): keep the REAL price/conf/expo bytes of the dumped push feed,
 * shift publish_time to `t` so it is fresh under the test clock. Optionally scale the price (spot-guard tests).
 */
export function shiftPushFeed(env: Env, feed: PublicKey, t: number, priceMul?: { num: bigint; den: bigint }) {
  const d = env.getData(feed)!;
  const o = priceUpdateOffsets(d);
  d.writeBigInt64LE(BigInt(t), o.publishTime);
  d.writeBigInt64LE(BigInt(t - 1), o.prevPublishTime);
  if (priceMul) d.writeBigInt64LE((d.readBigInt64LE(o.price) * priceMul.num) / priceMul.den, o.price);
  env.setRaw(feed, d, PYTH_RECEIVER_PROGRAM_ID);
}

export interface World {
  env: Env;
  admin: Keypair;
  agent: Keypair;
  feeRecipient: Keypair;
  user: Keypair;
  maker: Keypair;
  maker2: Keypair;
  asset: PublicKey;
}

export async function setupWorld(opts: { feeBps?: number; maxSpotAgeSecs?: number } = {}): Promise<World> {
  const env = new Env();
  const admin = env.newWallet(100);
  const agent = env.newWallet(100);
  const feeRecipient = env.newWallet(1);
  const user = env.newWallet(100);
  const maker = env.newWallet(100);
  const maker2 = env.newWallet(100);
  const c = env.client;
  env.send([await c.initConfig(admin.publicKey, agent.publicKey, opts.feeBps ?? 1000, feeRecipient.publicKey)], [admin]);
  env.send(
    [
      await c.addAsset(admin.publicKey, WSOL_MINT, {
        decimals: 9,
        pythFeedIdHex: PYTH_FEED_IDS.SOL_USD,
        spotFeed: SOL_FEED,
        strikeTick: 100_000n, // $0.10 (orchestrator decision)
        maxConfBps: 50,
        maxSpotMoveBps: 50,
        maxSpotAgeSecs: opts.maxSpotAgeSecs ?? 180,
        enabled: true,
      }),
    ],
    [admin],
  );
  return { env, admin, agent, feeRecipient, user, maker, maker2, asset: assetPda(WSOL_MINT)[0] };
}

export { configPda, USDC_MINT, WSOL_MINT };
