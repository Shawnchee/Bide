// IDL-backed BideChain built on the P lane's BideClient (packages/shared). Reads normalise Anchor's decoded
// accounts into chain/types.ts; writes use shared builders (pool_take_round / flip_plan built here from the IDL
// because the shared client has no builder for them yet — account layouts are frozen in the IDL).
import {
  BideClient, IDL, assetPda, ata, configPda, epochPda, escrowPda, lendAuthPda, lendMarketForMint, lendMarketMetas, poolPda,
  USDC_MINT, WSOL_MINT, LEND_MARKETS, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, cuLimitIx,
} from "@bide/shared";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { cfg } from "../config.js";
import type { EpochKind } from "../keeper/schedule.js";
import { FEED_IDS } from "../pyth/hermes.js";
import { buildFullUpdate, decodePriceUpdateV2, sendTx } from "../pyth/post.js";
import { makeConnection, withTimeout } from "./rpc.js";
import { sendAndConfirm } from "./send.js";
import { ChainNotReady, type BideChain, type OpenRoundArgs } from "./client.js";
import type { AssetState, ChainSnapshot, ConfigState, EpochState, PlanState, PoolState, RoundState } from "./types.js";

// ---------- normalisation helpers ----------
const big = (v: any): bigint => (v === null || v === undefined ? 0n : BigInt(v.toString()));
const num = (v: any): number => Number(v?.toString?.() ?? v ?? 0);
const pk = (v: any): string | null => (v ? (v as PublicKey).toBase58() : null);
const enumName = (v: any): string => { const k = Object.keys(v ?? {})[0] ?? ""; return k.charAt(0).toUpperCase() + k.slice(1); };
const hex = (v: any): string => Buffer.from(v ?? []).toString("hex");
const symbolFor = (feedHex: string): "SOL" | "BTC" => (feedHex === FEED_IDS.BTC ? "BTC" : "SOL");
const DEFAULT_PK = PublicKey.default.toBase58();
const optPk = (v: any) => { const s = pk(v); return s === DEFAULT_PK ? null : s; };

export function normPlan(pubkey: PublicKey, a: any): PlanState {
  return {
    pubkey: pubkey.toBase58(), owner: pk(a.owner)!, asset: pk(a.asset)!, side: enumName(a.side) as any, phase: enumName(a.phase) as any, quick: !!a.quick,
    targetStrike: big(a.targetStrike), exitStrike: big(a.exitStrike), strikeMin: big(a.strikeMin), strikeMax: big(a.strikeMax),
    callStrikeMin: big(a.callStrikeMin), callStrikeMax: big(a.callStrikeMax), lockStrike: !!a.lockStrike,
    sizeTotal: big(a.sizeTotal), sizeFilled: big(a.sizeFilled), collateralPrincipal: big(a.collateralPrincipal), lendShares: big(a.lendShares),
    pendingSettlement: optPk(a.pendingSettlement), minPremiumBpsPerDay: num(a.minPremiumBpsPerDay), maxExpirySecs: num(a.maxExpirySecs),
    horizonEnd: num(a.horizonEnd), maxRoundsPerDay: num(a.maxRoundsPerDay), roundsToday: num(a.roundsToday), dayIndex: num(a.dayIndex),
    roundCount: num(a.roundCount), activeRound: optPk(a.activeRound), paused: !!a.paused, status: enumName(a.status) as any,
  };
}
export function normRound(pubkey: PublicKey, a: any): RoundState {
  return {
    pubkey: pubkey.toBase58(), plan: pk(a.plan)!, asset: pk(a.asset)!, kind: enumName(a.kind) as any,
    strike: big(a.strike), size: big(a.size), notional: big(a.notional), epoch: pk(a.epoch)!, expiry: num(a.expiry),
    auctionStart: num(a.auctionStart), auctionSecs: num(a.auctionSecs), poolDelaySecs: num(a.poolDelaySecs), rentPayer: pk(a.rentPayer)!,
    premiumStart: big(a.premiumStart), premiumFloor: big(a.premiumFloor), spotAtOpen: big(a.spotAtOpen),
    maker: optPk(a.maker), makerIsPool: !!a.makerIsPool,
    premiumPaid: big(a.premiumPaid), feePaid: big(a.feePaid), exercised: num(a.exercised) as 0 | 1 | 2, settlePrice: big(a.settlePrice),
    memoHash: hex(a.memoHash), status: enumName(a.status) as any,
  };
}
export function normEpoch(pubkey: PublicKey, a: any): EpochState {
  return {
    pubkey: pubkey.toBase58(), asset: pk(a.asset)!, kind: enumName(a.kind) as EpochKind, expiry: num(a.expiry),
    nBuckets: num(a.nBuckets), bucketSecs: num(a.bucketSecs), bucketToleranceSecs: num(a.bucketToleranceSecs),
    samples: (a.samples ?? []).map(big), sampleMask: num(a.sampleMask), settlePrice: big(a.settlePrice), status: enumName(a.status) as any,
  };
}

export async function loadAnchorChain(label = "chain"): Promise<BideChain> {
  if (!cfg.programId) throw new ChainNotReady("PROGRAM_ID EMPTY");
  const programId = new PublicKey(cfg.programId);
  const connection = makeConnection(label);
  if (!(await connection.getAccountInfo(programId))) throw new ChainNotReady(`program ${cfg.programId} not deployed on this cluster`);
  if (!(await connection.getAccountInfo(configPda(programId)[0]))) throw new ChainNotReady("Config not initialised (init_config)");
  void IDL;
  return new AnchorBideChain(connection, new BideClient(connection, programId));
}

class AnchorBideChain implements BideChain {
  readonly programId: PublicKey;
  private program: any;
  private assetCache = new Map<string, { state: AssetState; raw: any }>();
  constructor(readonly connection: Connection, private client: BideClient) { this.programId = client.programId; this.program = client.program; }

  /** Hard cap on a full snapshot (each RPC call is already bounded by the fetch timeout; this bounds the sum). */
  snapshot(): Promise<ChainSnapshot> { return withTimeout(this.snapshotInner(), 30_000, "snapshot"); }

  async sampleView() {
    const acc = this.program.account;
    const [assets, rounds, epochs] = await withTimeout(Promise.all([acc.asset.all(), acc.round.all(), acc.epoch.all()]), 20_000, "sampleView");
    return {
      assets: assets.map((x: any) => this.normAsset(x)),
      rounds: rounds.map((x: any) => normRound(x.publicKey, x.account)),
      epochs: epochs.map((x: any) => normEpoch(x.publicKey, x.account)),
    };
  }

  private normAsset(x: any): AssetState {
    const feed = hex(x.account.pythFeedId);
    return {
      pubkey: x.publicKey.toBase58(), mint: pk(x.account.mint)!, decimals: num(x.account.decimals), pythFeedId: feed, strikeTick: big(x.account.strikeTick),
      maxConfBps: num(x.account.maxConfBps), maxSpotMoveBps: num(x.account.maxSpotMoveBps), maxSpotAgeSecs: num(x.account.maxSpotAgeSecs),
      enabled: !!x.account.enabled, symbol: symbolFor(feed),
    };
  }

  private async snapshotInner(): Promise<ChainSnapshot> {
    const acc = this.program.account;
    const [cfgAcc, assets, plans, rounds, epochs, slotTime] = await Promise.all([
      acc.config.fetch(configPda(this.programId)[0]),
      acc.asset.all(), acc.plan.all(), acc.round.all(), acc.epoch.all(),
      this.connection.getSlot().then((s) => this.connection.getBlockTime(s)).catch(() => null),
    ]);
    const config: ConfigState = { admin: pk(cfgAcc.admin)!, agent: pk(cfgAcc.agent)!, paused: !!cfgAcc.paused, feeBps: num(cfgAcc.feeBps), feeRecipient: pk(cfgAcc.feeRecipient)! };
    const assetStates: AssetState[] = assets.map((x: any) => {
      const feed = hex(x.account.pythFeedId);
      const s: AssetState = {
        pubkey: x.publicKey.toBase58(), mint: pk(x.account.mint)!, decimals: num(x.account.decimals), pythFeedId: feed, strikeTick: big(x.account.strikeTick),
        maxConfBps: num(x.account.maxConfBps), maxSpotMoveBps: num(x.account.maxSpotMoveBps), maxSpotAgeSecs: num(x.account.maxSpotAgeSecs),
        enabled: !!x.account.enabled, symbol: symbolFor(feed),
      };
      this.assetCache.set(s.pubkey, { state: s, raw: x.account });
      return s;
    });
    return {
      now: slotTime ?? Math.floor(Date.now() / 1000), config, assets: assetStates,
      plans: plans.map((x: any) => normPlan(x.publicKey, x.account)),
      rounds: rounds.map((x: any) => normRound(x.publicKey, x.account)),
      epochs: epochs.map((x: any) => normEpoch(x.publicKey, x.account)),
      pool: await this.pool(),
    };
  }

  private poolAuth() { return lendAuthPda(poolPda(this.programId)[0], this.programId)[0]; }

  private async pool(): Promise<PoolState | null> {
    const poolPk = poolPda(this.programId)[0];
    const a = await this.program.account.pool.fetchNullable(poolPk);
    if (!a) return null;
    const auth = this.poolAuth();
    const [usdcVault, wsolVault] = await Promise.all([this.tokenBalance(auth, USDC_MINT), this.tokenBalance(auth, WSOL_MINT)]);
    return {
      pubkey: poolPk.toBase58(), paused: !!a.paused, maxPremiumBpsOfNotional: num(a.maxPremiumBpsOfNotional), maxOpenNotional: big(a.maxOpenNotional),
      maxUtilizationBps: num(a.maxUtilizationBps), spendWindowSecs: num(a.spendWindowSecs), spendWindowStart: num(a.spendWindowStart),
      spendWindowCap: big(a.spendWindowCap), spendWindowSpent: big(a.spendWindowSpent), lendShares: big(a.lendShares),
      reservedUsdc: big(a.reservedUsdc), reservedWsol: big(a.reservedWsol), openNotional: big(a.openNotional), usdcVault, wsolVault,
    };
  }

  private spotFeeds = new Map<string, PublicKey>();
  /** Age (s, wall clock) of the asset's push feed (asset.spot_feed) — the price open_round / take_round check against max_spot_age_secs. */
  async spotAgeSecs(asset: PublicKey): Promise<number> {
    let feed = this.spotFeeds.get(asset.toBase58());
    if (!feed) { feed = (await this.program.account.asset.fetch(asset)).spotFeed as PublicKey; this.spotFeeds.set(asset.toBase58(), feed); }
    const info = await this.connection.getAccountInfo(feed);
    if (!info) return Number.POSITIVE_INFINITY;
    return Math.floor(Date.now() / 1000) - decodePriceUpdateV2(info.data).publishTime;
  }

  async tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    try { return BigInt((await this.connection.getTokenAccountBalance(ata(mint, owner))).value.amount); } catch { return 0n; }
  }

  private fetchRound(r: PublicKey) { return this.program.account.round.fetch(r); }
  private fetchPlan(p: PublicKey) { return this.program.account.plan.fetch(p); }
  private fetchAssetByPk(a: PublicKey) { return this.program.account.asset.fetch(a); }
  private send(signer: Keypair, ixs: TransactionInstruction[], cu = 200_000, signers: Keypair[] = []) {
    // sendAndConfirm prepends its own CU limit/price ixs and drops any CU ix from the shared builders.
    return sendAndConfirm(this.connection, signer, ixs, signers, { cu });
  }

  async openEpoch(signer: Keypair, asset: PublicKey, kind: EpochKind, expiry: number) {
    const mint = (await this.fetchAssetByPk(asset)).mint as PublicKey;
    return this.send(signer, [await this.client.openEpoch(signer.publicKey, mint, kind === "Std" ? "std" : "quick", expiry)]);
  }

  async openRound(agent: Keypair, planPk: PublicKey, a: OpenRoundArgs) {
    const p = await this.fetchPlan(planPk);
    if (p.roundCount !== a.roundIndex) p.roundCount = a.roundIndex; // index chosen by the keeper from the same snapshot
    const asset = await this.fetchAssetByPk(p.asset);
    const ix = await this.client.openRound(agent.publicKey, planPk, p, asset, a.epoch, {
      strike: a.strike, size: a.size, auctionSecs: a.auctionSecs, premiumStart: a.premiumStart, premiumFloor: a.premiumFloor, memoHash: a.memoHash,
    });
    // Rejections must be real on-chain txs with an explorer link (/desk hero) → skipPreflight.
    return sendLanded(this.connection, agent, [ix], [], 200_000);
  }

  async takeRound(maker: Keypair, roundPk: PublicKey) {
    const r = await this.fetchRound(roundPk);
    const [p, asset, c] = await Promise.all([this.fetchPlan(r.plan), this.fetchAssetByPk(r.asset), this.client.fetchConfig()]);
    return this.send(maker, await this.client.takeRound(maker.publicKey, roundPk, r, p, asset, c.feeRecipient));
  }

  async poolTakeRound(signer: Keypair, roundPk: PublicKey) {
    const r = await this.fetchRound(roundPk);
    const [p, asset, c] = await Promise.all([this.fetchPlan(r.plan), this.fetchAssetByPk(r.asset), this.client.fetchConfig()]);
    const auth = this.poolAuth();
    const idem = (owner: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, ata(USDC_MINT, owner), owner, USDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await this.program.methods.poolTakeRound().accountsPartial({
      payer: signer.publicKey, config: configPda(this.programId)[0], asset: r.asset, plan: r.plan, round: roundPk,
      epoch: r.epoch, escrow: escrowPda(roundPk, this.programId)[0], spotFeed: asset.spotFeed, pool: poolPda(this.programId)[0], poolAuth: auth,
      poolUsdc: ata(USDC_MINT, auth), poolWsol: ata(WSOL_MINT, auth), lendingUsdc: LEND_MARKETS.USDC.lending,
      ownerUsdc: ata(USDC_MINT, p.owner), feeUsdc: ata(USDC_MINT, c.feeRecipient), tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return this.send(signer, [idem(p.owner), idem(c.feeRecipient), ix]);
  }

  async cancelRound(signer: Keypair, roundPk: PublicKey) {
    // Pass the plan so a donated escrow balance is swept to the owner (creates the owner's escrow-mint ATA).
    const r = await this.fetchRound(roundPk);
    return this.send(signer, await this.client.cancelRoundIxs(signer.publicKey, roundPk, r, await this.fetchPlan(r.plan)));
  }

  async postSample(signer: Keypair, epochPk: PublicKey, bucket: number, hermesUpdateBase64: string) {
    const ep = await this.program.account.epoch.fetch(epochPk);
    const asset = await this.fetchAssetByPk(ep.asset);
    const feed = hex(asset.pythFeedId);
    const plan = await buildFullUpdate(this.connection, signer.publicKey, hermesUpdateBase64);
    const priceUpdate = plan.priceUpdateAccounts[feed];
    if (!priceUpdate) throw new Error("hermes update does not contain the asset feed");
    const consumer = await this.client.postSample(asset.mint, epochPk, priceUpdate, bucket);
    const sigA = await sendTx(this.connection, signer, plan.txA.ixs, plan.txA.signers, 50_000);
    const sigB = await sendTx(this.connection, signer, [...plan.txB.ixs, consumer, ...plan.closeIxs], plan.txB.signers, 600_000);
    return [sigA, sigB];
  }

  async resolveEpoch(signer: Keypair, epoch: PublicKey) {
    return this.send(signer, [await this.client.resolveEpoch(epoch)]);
  }
  async resolveRound(signer: Keypair, roundPk: PublicKey) {
    const r = await this.fetchRound(roundPk);
    return this.send(signer, await this.client.resolveRound(signer.publicKey, roundPk, r, await this.fetchPlan(r.plan)));
  }
  async withdrawCollateral(signer: Keypair, roundPk: PublicKey) {
    const r = await this.fetchRound(roundPk);
    return this.send(signer, await this.client.withdrawCollateral(signer.publicKey, roundPk, r, await this.fetchPlan(r.plan)), 400_000);
  }
  async unwindRound(signer: Keypair, roundPk: PublicKey) {
    const r = await this.fetchRound(roundPk);
    return this.send(signer, await this.client.unwindRound(signer.publicKey, roundPk, r, await this.fetchPlan(r.plan)));
  }
  async expirePlan(signer: Keypair, planPk: PublicKey) {
    return this.send(signer, await this.client.closePlan(signer.publicKey, planPk, await this.fetchPlan(planPk), true), 400_000);
  }
  async flipPlan(agent: Keypair, planPk: PublicKey) {
    // Remaining: 13 USDC Lend market accounts, then 13 asset Lend market accounts (programs/bide plan.rs FlipPlan doc).
    const p = await this.fetchPlan(planPk);
    const [lendAuth] = lendAuthPda(planPk, this.programId);
    const assetMarket = lendMarketForMint(p.assetMint);
    const idem = (owner: PublicKey, mint: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, ata(mint, owner), owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const pre = [idem(p.owner, USDC_MINT), idem(lendAuth, p.assetMint), ...(assetMarket ? [idem(lendAuth, assetMarket.fTokenMint)] : [])];
    const ix = await this.program.methods.flipPlan().accountsPartial({
      agent: agent.publicKey, config: configPda(this.programId)[0], plan: planPk, lendAuth,
      vaultUsdc: ata(USDC_MINT, lendAuth), vaultUsdcFToken: ata(LEND_MARKETS.USDC.fTokenMint, lendAuth), ownerUsdc: ata(USDC_MINT, p.owner),
      vaultAsset: ata(p.assetMint, lendAuth), vaultAssetFToken: assetMarket ? ata(assetMarket.fTokenMint, lendAuth) : null,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts([...lendMarketMetas(LEND_MARKETS.USDC), ...(assetMarket ? lendMarketMetas(assetMarket) : [])]).instruction();
    return this.send(agent, [...pre, ix], 400_000);
  }
}

/**
 * Send with skipPreflight so a program rejection lands on-chain (failed tx with explorer link).
 * On failure throws an Error carrying `.signature` and `.logs` (parsed by parseProgramError).
 */
export function sendLanded(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[], cu: number): Promise<string> {
  return sendAndConfirm(connection, payer, ixs, signers, { cu, skipPreflight: true });
}
export { assetPda, epochPda, cuLimitIx };
