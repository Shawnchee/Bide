// The worker's only door to the Bide program. Keeper/makers depend on this interface, never on Anchor.
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { EpochKind } from "../keeper/schedule.js";
import type { ChainSnapshot } from "./types.js";

export interface OpenRoundArgs {
  roundIndex: number;
  strike: bigint;
  size: bigint;
  auctionSecs: number;
  premiumStart: bigint;
  premiumFloor: bigint;
  memoHash: Uint8Array; // 32 bytes
  epoch: PublicKey;
}

export interface BideChain {
  readonly programId: PublicKey;
  readonly connection: Connection;
  /** Full state read used by keeper/makers/mirror each tick. */
  snapshot(): Promise<ChainSnapshot>;
  /** Lighter read for the sampler (assets, rounds, epochs only). Optional: falls back to snapshot(). */
  sampleView?(): Promise<Pick<ChainSnapshot, "assets" | "rounds" | "epochs">>;
  tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint>;
  /** Age in seconds of the asset's Pyth push feed (asset.spot_feed). Optional (test fakes omit it). */
  spotAgeSecs?(asset: PublicKey): Promise<number>;

  openEpoch(signer: Keypair, asset: PublicKey, kind: EpochKind, expiry: number): Promise<string>;
  openRound(agent: Keypair, plan: PublicKey, args: OpenRoundArgs): Promise<string>;
  takeRound(maker: Keypair, round: PublicKey): Promise<string>;
  poolTakeRound(signer: Keypair, round: PublicKey): Promise<string>;
  cancelRound(signer: Keypair, round: PublicKey): Promise<string>;
  /** Posts the Hermes update (Full verification, 2 txs) and `post_sample` in tx B with closeUpdateAccounts. */
  postSample(signer: Keypair, epoch: PublicKey, bucket: number, hermesUpdateBase64: string): Promise<string[]>;
  resolveEpoch(signer: Keypair, epoch: PublicKey): Promise<string>;
  resolveRound(signer: Keypair, round: PublicKey): Promise<string>;
  withdrawCollateral(signer: Keypair, round: PublicKey): Promise<string>;
  unwindRound(signer: Keypair, round: PublicKey): Promise<string>;
  expirePlan(signer: Keypair, plan: PublicKey): Promise<string>;
  flipPlan(agent: Keypair, plan: PublicKey): Promise<string>;
}

export class ChainNotReady extends Error {
  constructor(what: string) { super(`chain not ready: ${what}`); this.name = "ChainNotReady"; }
}
