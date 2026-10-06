// The ONLY place the app touches the Bide program interface. Wraps the P lane's BideClient
// (@bide/shared) behind a small app-facing interface so pages never import Anchor directly.

import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { BideClient, IDL, ROUND_STATUS_OFFSET, assetPda, type PlanAccount, type RoundAccount } from "@bide/shared";
import { PROGRAM_ID, WSOL_MINT } from "./constants";
import { wrapSolIxs } from "./wrap";
import type { AssetInfo } from "./constants";
import type { CreatePlanArgs } from "./plan-math";

const ROUND_DISC = Uint8Array.from(
  (IDL as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "Round")!.discriminator,
);

export interface DecodedRound {
  pubkey: string;
  plan: string;
  asset: string;
  kind: "put" | "call";
  strike: bigint;
  size: bigint;
  notional: bigint;
  epoch: string;
  expiry: number;
  auctionStart: number;
  auctionSecs: number;
  poolDelaySecs: number;
  premiumStart: bigint;
  premiumFloor: bigint;
  spotAtOpen: bigint;
  maker: string | null;
  status: "auction" | "live" | "cancelled" | "resolved" | "settled" | "unwound";
  memoHash: string;
}

export interface DecodedPlan {
  pubkey: string;
  owner: string;
  side: "buy" | "sell" | "wheel";
  phase: "accumulate" | "exit";
  quick: boolean;
  targetStrike: bigint;
  exitStrike: bigint;
  sizeTotal: bigint;
  sizeFilled: bigint;
  collateralPrincipal: bigint;
  lendShares: bigint;
  horizonEnd: number;
  activeRound: string | null;
  pendingSettlement: string | null;
  paused: boolean;
  status: "active" | "filled" | "closed";
}

/** On-chain backstop pool: caps + vault balances (whole tokens). */
export interface DecodedPool {
  pubkey: string;
  paused: boolean;
  maxPremiumBpsOfNotional: number;
  maxOpenNotional: number; // USDC
  maxUtilizationBps: number;
  spendWindowSecs: number;
  spendWindowCap: number; // USDC
  spendWindowSpent: number; // USDC
  openNotional: number; // USDC
  usdcVault: number; // USDC sitting in the pool vault
  lendFTokens: number; // Jupiter Lend fToken shares (≈ USDC; exchange rate slightly above 1)
  wsolVault: number; // WSOL
  reservedUsdc: number;
  reservedWsol: number;
}

export interface BideProgramClient {
  /** create_plan (+ any Lend remaining accounts). Compute budget / WSOL wrap are added by lib/tx.ts. */
  createPlanIxs(p: { conn: Connection; owner: PublicKey; asset: AssetInfo; args: CreatePlanArgs }): Promise<TransactionInstruction[]>;
  takeRoundIxs(p: { conn: Connection; maker: PublicKey; round: DecodedRound }): Promise<TransactionInstruction[]>;
  pausePlanIx(p: { owner: PublicKey; plan: PublicKey; paused: boolean }): Promise<TransactionInstruction>;
  closePlanIxs(p: { conn: Connection; owner: PublicKey; plan: PublicKey }): Promise<TransactionInstruction[]>;
  poolDepositIxs?(p: { conn: Connection; lp: PublicKey; mint: PublicKey; amount: bigint }): Promise<TransactionInstruction[]>;
  poolWithdrawIxs?(p: { conn: Connection; lp: PublicKey; shares: bigint }): Promise<TransactionInstruction[]>;
  fetchAuctionRounds(conn: Connection): Promise<DecodedRound[]>;
  fetchPlan(conn: Connection, plan: PublicKey): Promise<DecodedPlan | null>;
  /** Asset.strike_tick from chain (null if the Asset account doesn't exist yet). */
  fetchStrikeTick(conn: Connection, mint: PublicKey): Promise<bigint | null>;
  /** Config.fee_bps from chain. */
  fetchFeeBps(conn: Connection): Promise<number>;
  /** Pool account + vault balances (null if the pool isn't initialised). */
  fetchPool(conn: Connection): Promise<DecodedPool | null>;
}

let cached: { conn: Connection; client: BideProgramClient } | null = null;

const pk = (v: PublicKey | null | undefined) => (v ? v.toBase58() : null);
const big = (v: { toString(): string } | null | undefined) => BigInt(v ? v.toString() : "0");
const num = (v: { toString(): string } | number) => Number(v.toString());
const name = (v: Record<string, unknown>) => Object.keys(v)[0];
const hex = (a: number[]) => a.map((b) => b.toString(16).padStart(2, "0")).join("");

function toRound(pubkey: PublicKey, r: RoundAccount): DecodedRound {
  return {
    pubkey: pubkey.toBase58(),
    plan: r.plan.toBase58(),
    asset: r.asset.toBase58(),
    kind: name(r.kind) as DecodedRound["kind"],
    strike: big(r.strike),
    size: big(r.size),
    notional: big(r.notional),
    epoch: r.epoch.toBase58(),
    expiry: num(r.expiry),
    auctionStart: num(r.auctionStart),
    auctionSecs: r.auctionSecs,
    poolDelaySecs: r.poolDelaySecs,
    premiumStart: big(r.premiumStart),
    premiumFloor: big(r.premiumFloor),
    spotAtOpen: big(r.spotAtOpen),
    maker: r.maker.equals(PublicKey.default) ? null : r.maker.toBase58(),
    status: name(r.status) as DecodedRound["status"],
    memoHash: hex(r.memoHash as number[]),
  };
}

function toPlan(pubkey: PublicKey, p: PlanAccount): DecodedPlan {
  return {
    pubkey: pubkey.toBase58(),
    owner: p.owner.toBase58(),
    side: name(p.side) as DecodedPlan["side"],
    phase: name(p.phase) as DecodedPlan["phase"],
    quick: p.quick,
    targetStrike: big(p.targetStrike),
    exitStrike: big(p.exitStrike),
    sizeTotal: big(p.sizeTotal),
    sizeFilled: big(p.sizeFilled),
    collateralPrincipal: big(p.collateralPrincipal),
    lendShares: big(p.lendShares),
    horizonEnd: num(p.horizonEnd),
    activeRound: pk(p.activeRound),
    pendingSettlement: pk(p.pendingSettlement),
    paused: p.paused,
    status: name(p.status) as DecodedPlan["status"],
  };
}

function makeClient(conn: Connection): BideProgramClient {
  const bide = new BideClient(conn, PROGRAM_ID);
  return {
    async createPlanIxs({ owner, asset, args }) {
      const { ixs } = await bide.createPlan(owner, asset.mint, {
        nonce: args.nonce,
        side: args.side,
        quick: args.quick,
        targetStrike: args.targetStrike,
        exitStrike: args.exitStrike,
        sizeTotal: args.sizeTotal,
        lockStrike: args.lockStrike,
        band: args.band,
        exitBand: args.exitBand,
        minPremiumBpsPerDay: args.minPremiumBpsPerDay,
        maxExpirySecs: args.maxExpirySecs,
        horizonEnd: args.horizonEnd,
        maxRoundsPerDay: args.maxRoundsPerDay,
      });
      return ixs;
    },
    async takeRoundIxs({ maker, round }) {
      const roundPk = new PublicKey(round.pubkey);
      const r = await bide.fetchRound(roundPk);
      const [p, cfg] = await Promise.all([bide.fetchPlan(r.plan), bide.fetchConfig()]);
      const a = await bide.fetchAsset(p.assetMint);
      const ixs = [...(await bide.takeRound(maker, roundPk, r, p, a, cfg.feeRecipient))];
      // Put rounds escrow the asset; for SOL the maker needs WSOL — wrap exactly `size` in the same tx.
      if ("put" in r.kind && a.mint.equals(WSOL_MINT)) ixs.unshift(...wrapSolIxs(maker, big(r.size)));
      return ixs;
    },
    async pausePlanIx({ owner, plan, paused }) {
      return bide.pausePlan(owner, plan, paused);
    },
    async closePlanIxs({ owner, plan }) {
      const p = await bide.fetchPlan(plan);
      return bide.closePlan(owner, plan, p, false);
    },
    // Pool handlers ship in a later program upgrade (notes/program.md) — no builders yet.
    async fetchAuctionRounds(c) {
      const rows = await c.getProgramAccounts(PROGRAM_ID, {
        commitment: "confirmed",
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(ROUND_DISC) } },
          { memcmp: { offset: ROUND_STATUS_OFFSET, bytes: bs58.encode(Uint8Array.from([0])) } },
        ],
      });
      return rows.map((r) => toRound(r.pubkey, bide.program.coder.accounts.decode<RoundAccount>("round", r.account.data)));
    },
    async fetchPlan(_c, plan) {
      const p = await bide.program.account.plan.fetchNullable(plan);
      return p ? toPlan(plan, p) : null;
    },
    async fetchStrikeTick(_c, mint) {
      const a = await bide.program.account.asset.fetchNullable(assetPda(mint, PROGRAM_ID)[0]);
      return a ? big(a.strikeTick) : null;
    },
    async fetchFeeBps() {
      const cfg = await bide.fetchConfig();
      return cfg.feeBps;
    },
    async fetchPool(c) {
      const a = bide.poolAccounts();
      const p = await bide.program.account.pool.fetchNullable(a.pool);
      if (!p) return null;
      const bal = async (ata: PublicKey) => {
        try {
          return (await c.getTokenAccountBalance(ata, "confirmed")).value.uiAmount ?? 0;
        } catch {
          return 0;
        }
      };
      const [usdcVault, wsolVault, lendFTokens] = await Promise.all([bal(a.poolUsdc), bal(a.poolWsol), bal(a.poolFToken)]);
      const usdc6 = (v: { toString(): string }) => Number(big(v)) / 1e6;
      return {
        pubkey: a.pool.toBase58(),
        paused: Boolean(p.paused),
        maxPremiumBpsOfNotional: Number(p.maxPremiumBpsOfNotional),
        maxOpenNotional: usdc6(p.maxOpenNotional),
        maxUtilizationBps: Number(p.maxUtilizationBps),
        spendWindowSecs: Number(p.spendWindowSecs),
        spendWindowCap: usdc6(p.spendWindowCap),
        spendWindowSpent: usdc6(p.spendWindowSpent),
        openNotional: usdc6(p.openNotional),
        usdcVault,
        lendFTokens,
        wsolVault,
        reservedUsdc: usdc6(p.reservedUsdc),
        reservedWsol: Number(big(p.reservedWsol)) / 1e9,
      };
    },
  };
}

/** Program client bound to the given connection (cached). */
export function getBideClient(conn?: Connection): BideProgramClient | null {
  if (!conn) return cached?.client ?? null;
  if (!cached || cached.conn !== conn) cached = { conn, client: makeClient(conn) };
  return cached.client;
}

/** Shown when the program isn't deployed or an instruction isn't live yet. */
export const PROGRAM_NOT_READY =
  "This action isn't live on devnet yet (program not deployed or instruction not enabled). Nothing has been sent.";
