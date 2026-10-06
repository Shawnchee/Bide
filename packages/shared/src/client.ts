// Instruction builders for the Bide program (used by worker / app / scripts / tests).
// Every builder returns plain web3.js TransactionInstructions; callers add signers and send.
import { BN, Program, type Provider } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { IDL } from "./idl/idl.js";
import type { Bide } from "./idl/bide.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  LEND_LENDING_ADMIN,
  LEND_LIQUIDITY,
  LEND_PROGRAM_ID,
  LIQUIDITY_PROGRAM_ID,
  LEND_TX_CU_LIMIT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
  LEND_MARKETS,
  PYTH_PUSH_FEEDS,
  lendMarketForMint,
  type LendMarket,
} from "./constants.js";
import { assetPda, ata, configPda, epochPda, escrowPda, lendAuthPda, planPda, poolMintPda, poolPda, roundPda } from "./pda.js";
import type { AssetAccount, PlanAccount, RoundAccount, SideName, EpochKindName } from "./types.js";

/** 13 Lend market accounts in the program's canonical order (programs/bide/src/lend.rs). */
export function lendMarketMetas(m: LendMarket): AccountMeta[] {
  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  return [
    r(LEND_LENDING_ADMIN),
    w(m.lending),
    r(m.mint),
    w(m.fTokenMint),
    w(m.reserve),
    w(m.supplyPosition),
    r(m.rateModel),
    w(m.vault),
    w(m.claimAccount),
    w(LEND_LIQUIDITY),
    w(LIQUIDITY_PROGRAM_ID), // deployed devnet Lend requires mut
    r(m.rewardsRateModel),
    r(LEND_PROGRAM_ID),
  ];
}

/** All addresses worth putting in an address lookup table for Lend CPIs. */
export function lendAltAddresses(): PublicKey[] {
  const out: PublicKey[] = [TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, USDC_MINT];
  for (const mint of [USDC_MINT, new PublicKey("So11111111111111111111111111111111111111112")]) {
    const m = lendMarketForMint(mint)!;
    for (const a of lendMarketMetas(m)) if (!out.some((x) => x.equals(a.pubkey))) out.push(a.pubkey);
  }
  return out;
}

export const cuLimitIx = (units = LEND_TX_CU_LIMIT) => ComputeBudgetProgram.setComputeUnitLimit({ units });

const idemAta = (payer: PublicKey, owner: PublicKey, mint: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner), owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

const sideArg = (s: SideName) => ({ [s]: {} }) as never;
const kindArg = (k: EpochKindName) => ({ [k]: {} }) as never;
const bn = (x: bigint | number) => new BN(x.toString());

export class BideClient {
  readonly program: Program<Bide>;
  constructor(readonly connection: Connection, programId?: PublicKey) {
    const idl = programId ? { ...IDL, address: programId.toBase58() } : IDL;
    this.program = new Program<Bide>(idl as Bide, { connection } as unknown as Provider);
  }
  get programId() {
    return this.program.programId;
  }

  // ---------- fetchers ----------
  fetchConfig() {
    return this.program.account.config.fetch(configPda(this.programId)[0]);
  }
  fetchAsset(mint: PublicKey) {
    return this.program.account.asset.fetch(assetPda(mint, this.programId)[0]);
  }
  fetchPlan(plan: PublicKey) {
    return this.program.account.plan.fetch(plan);
  }
  fetchRound(round: PublicKey) {
    return this.program.account.round.fetch(round);
  }
  fetchEpoch(epoch: PublicKey) {
    return this.program.account.epoch.fetch(epoch);
  }

  // ---------- admin ----------
  initConfig(admin: PublicKey, agent: PublicKey, feeBps: number, feeRecipient: PublicKey) {
    return this.program.methods
      .initConfig(agent, feeBps, feeRecipient)
      .accountsPartial({ admin, config: configPda(this.programId)[0], systemProgram: SystemProgram.programId })
      .instruction();
  }

  addAsset(admin: PublicKey, mint: PublicKey, p: AssetParamsInput) {
    return this.program.methods
      .addAsset(toAssetParams(p))
      .accountsPartial({
        admin,
        config: configPda(this.programId)[0],
        mint,
        asset: assetPda(mint, this.programId)[0],
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  updateAsset(admin: PublicKey, mint: PublicKey, p: AssetParamsInput) {
    return this.program.methods
      .updateAsset(toAssetParams(p))
      .accountsPartial({ admin, config: configPda(this.programId)[0], asset: assetPda(mint, this.programId)[0] })
      .instruction();
  }

  rotateAgent(admin: PublicKey, newAgent: PublicKey) {
    return this.program.methods.rotateAgent(newAgent).accountsPartial({ admin, config: configPda(this.programId)[0] }).instruction();
  }
  setPaused(admin: PublicKey, paused: boolean) {
    return this.program.methods.setPaused(paused).accountsPartial({ admin, config: configPda(this.programId)[0] }).instruction();
  }
  setFee(admin: PublicKey, feeBps: number, feeRecipient: PublicKey) {
    return this.program.methods.setFee(feeBps, feeRecipient).accountsPartial({ admin, config: configPda(this.programId)[0] }).instruction();
  }

  // ---------- plans ----------
  /**
   * create_plan + pre-instructions (CU limit, idempotent vault ATAs).
   * Sell plans on SOL: the caller must wrap SOL into the owner's WSOL ATA first (same tx is fine).
   */
  async createPlan(owner: PublicKey, assetMint: PublicKey, a: CreatePlanInput): Promise<{ ixs: TransactionInstruction[]; plan: PublicKey }> {
    const [plan] = planPda(owner, a.nonce, this.programId);
    const [lendAuth] = lendAuthPda(plan, this.programId);
    const collateralMint = a.side === "sell" ? assetMint : USDC_MINT;
    const market = lendMarketForMint(collateralMint);
    const ixs: TransactionInstruction[] = [cuLimitIx(), idemAta(owner, lendAuth, collateralMint)];
    if (market) ixs.push(idemAta(owner, lendAuth, market.fTokenMint));
    ixs.push(
      await this.program.methods
        .createPlan({
          nonce: bn(a.nonce),
          side: sideArg(a.side),
          quick: a.quick,
          targetStrike: bn(a.targetStrike ?? 0),
          exitStrike: bn(a.exitStrike ?? 0),
          sizeTotal: bn(a.sizeTotal),
          lockStrike: a.lockStrike ?? true,
          band: bn(a.band ?? 0),
          exitBand: bn(a.exitBand ?? 0),
          minPremiumBpsPerDay: a.minPremiumBpsPerDay,
          maxExpirySecs: a.maxExpirySecs,
          horizonEnd: bn(a.horizonEnd),
          maxRoundsPerDay: a.maxRoundsPerDay,
        })
        .accountsPartial({
          owner,
          config: configPda(this.programId)[0],
          asset: assetPda(assetMint, this.programId)[0],
          plan,
          lendAuth,
          collateralMint,
          ownerCollateral: a.ownerCollateral ?? ata(collateralMint, owner),
          vaultCollateral: ata(collateralMint, lendAuth),
          vaultFToken: market ? ata(market.fTokenMint, lendAuth) : null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(market ? lendMarketMetas(market) : [])
        .instruction(),
    );
    return { ixs, plan };
  }

  pausePlan(owner: PublicKey, plan: PublicKey, paused: boolean) {
    return this.program.methods.pausePlan(paused).accountsPartial({ owner, plan }).instruction();
  }

  /** close_plan (caller = owner) or expire_plan (caller = anyone). Includes CU limit + idempotent owner ATAs. */
  async closePlan(caller: PublicKey, plan: PublicKey, p: PlanAccount, expire = false): Promise<TransactionInstruction[]> {
    const [lendAuth] = lendAuthPda(plan, this.programId);
    const exitPhase = "sell" in p.side || ("wheel" in p.side && "exit" in p.phase);
    const mint = exitPhase ? p.assetMint : USDC_MINT;
    const market = lendMarketForMint(mint);
    const wheelAccumulate = "wheel" in p.side && "accumulate" in p.phase;
    const ixs = [cuLimitIx(), idemAta(caller, p.owner, mint)];
    if (wheelAccumulate) ixs.push(idemAta(caller, p.owner, p.assetMint), idemAta(caller, lendAuth, p.assetMint));
    const m = expire ? this.program.methods.expirePlan() : this.program.methods.closePlan();
    ixs.push(
      await m
        .accountsPartial({
          caller,
          plan,
          lendAuth,
          vaultCollateral: ata(mint, lendAuth),
          vaultFToken: market ? ata(market.fTokenMint, lendAuth) : null,
          ownerCollateral: ata(mint, p.owner),
          vaultAsset: wheelAccumulate ? ata(p.assetMint, lendAuth) : null,
          ownerAsset: wheelAccumulate ? ata(p.assetMint, p.owner) : null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(market ? lendMarketMetas(market) : [])
        .instruction(),
    );
    return ixs;
  }

  // ---------- epochs ----------
  openEpoch(payer: PublicKey, assetMint: PublicKey, kind: EpochKindName, expiry: number) {
    const [asset] = assetPda(assetMint, this.programId);
    return this.program.methods
      .openEpoch(kindArg(kind), bn(expiry))
      .accountsPartial({ payer, asset, epoch: epochPda(asset, kind === "std" ? 0 : 1, expiry, this.programId)[0], systemProgram: SystemProgram.programId })
      .instruction();
  }

  postSample(assetMint: PublicKey, epoch: PublicKey, priceUpdate: PublicKey, bucket: number) {
    return this.program.methods
      .postSample(bucket)
      .accountsPartial({ asset: assetPda(assetMint, this.programId)[0], epoch, priceUpdate })
      .instruction();
  }

  resolveEpoch(epoch: PublicKey) {
    return this.program.methods.resolveEpoch().accountsPartial({ epoch }).instruction();
  }

  // ---------- rounds ----------
  openRound(agent: PublicKey, plan: PublicKey, p: PlanAccount, asset: AssetAccount, epoch: PublicKey, a: OpenRoundInput) {
    const [round] = roundPda(plan, p.roundCount, this.programId);
    const isPut = "buy" in p.side || ("wheel" in p.side && "accumulate" in p.phase);
    return this.program.methods
      .openRound({
        roundIndex: p.roundCount,
        strike: bn(a.strike),
        size: bn(a.size),
        auctionSecs: a.auctionSecs,
        premiumStart: bn(a.premiumStart),
        premiumFloor: bn(a.premiumFloor),
        memoHash: Array.from(a.memoHash),
      })
      .accountsPartial({
        agent,
        config: configPda(this.programId)[0],
        asset: p.asset,
        plan,
        epoch,
        round,
        escrowMint: isPut ? asset.mint : USDC_MINT,
        escrow: escrowPda(round, this.programId)[0],
        spotFeed: asset.spotFeed,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** take_round + idempotent ATAs for owner/fee recipient (maker pays rent). */
  async takeRound(maker: PublicKey, round: PublicKey, r: RoundAccount, p: PlanAccount, asset: AssetAccount, feeRecipient: PublicKey) {
    const isPut = "put" in r.kind;
    return [
      idemAta(maker, p.owner, USDC_MINT),
      idemAta(maker, feeRecipient, USDC_MINT),
      await this.program.methods
        .takeRound()
        .accountsPartial({
          maker,
          config: configPda(this.programId)[0],
          asset: r.asset,
          plan: r.plan,
          round,
          escrow: escrowPda(round, this.programId)[0],
          spotFeed: asset.spotFeed,
          makerUsdc: ata(USDC_MINT, maker),
          makerAsset: isPut ? ata(asset.mint, maker) : null,
          ownerUsdc: ata(USDC_MINT, p.owner),
          feeUsdc: ata(USDC_MINT, feeRecipient),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  /**
   * cancel_round. remaining_accounts[0] = plan owner's token account of the escrow mint (used only if someone
   * donated tokens into the escrow; must exist then — see cancelRoundIxs). Pass `p` (plan) to include it.
   */
  cancelRound(signer: PublicKey, round: PublicKey, r: RoundAccount, p?: PlanAccount) {
    const sweep: AccountMeta[] = p
      ? [{ pubkey: ata("put" in r.kind ? p.assetMint : USDC_MINT, p.owner), isSigner: false, isWritable: true }]
      : [];
    return this.program.methods
      .cancelRound()
      .accountsPartial({
        signer,
        config: configPda(this.programId)[0],
        plan: r.plan,
        round,
        escrow: escrowPda(round, this.programId)[0],
        rentPayer: r.rentPayer,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(sweep)
      .instruction();
  }

  /** cancel_round + idempotent creation of the owner's escrow-mint ATA (robust to escrow donations). */
  async cancelRoundIxs(signer: PublicKey, round: PublicKey, r: RoundAccount, p: PlanAccount): Promise<TransactionInstruction[]> {
    const mint = "put" in r.kind ? p.assetMint : USDC_MINT;
    return [idemAta(signer, p.owner, mint), await this.cancelRound(signer, round, r, p)];
  }

  /** Destination accounts the maker side gets back (maker ATA, or pool vault). */
  private makerDest(r: RoundAccount, mint: PublicKey) {
    return r.makerIsPool ? ata(mint, lendAuthPda(poolPda(this.programId)[0], this.programId)[0]) : ata(mint, r.maker);
  }

  /** resolve_round + idempotent ATAs (caller pays rent) for whichever side may receive. */
  async resolveRound(caller: PublicKey, round: PublicKey, r: RoundAccount, p: PlanAccount) {
    const isPut = "put" in r.kind;
    const escrowMint = isPut ? p.assetMint : USDC_MINT;
    const [lendAuth] = lendAuthPda(r.plan, this.programId);
    const userOwner = isPut && "wheel" in p.side ? lendAuth : p.owner;
    const makerOwner = r.makerIsPool ? lendAuthPda(poolPda(this.programId)[0], this.programId)[0] : r.maker;
    return [
      idemAta(caller, userOwner, escrowMint),
      idemAta(caller, makerOwner, escrowMint),
      await this.program.methods
        .resolveRound()
        .accountsPartial({
          plan: r.plan,
          round,
          epoch: r.epoch,
          escrow: escrowPda(round, this.programId)[0],
          userDest: ata(escrowMint, userOwner),
          makerDest: ata(escrowMint, makerOwner),
          rentPayer: r.rentPayer,
          pool: r.makerIsPool ? poolPda(this.programId)[0] : null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  async withdrawCollateral(caller: PublicKey, round: PublicKey, r: RoundAccount, p: PlanAccount) {
    const isPut = "put" in r.kind;
    const mint = isPut ? USDC_MINT : p.assetMint;
    const market = lendMarketForMint(mint);
    const [lendAuth] = lendAuthPda(r.plan, this.programId);
    const makerOwner = r.makerIsPool ? lendAuthPda(poolPda(this.programId)[0], this.programId)[0] : r.maker;
    return [
      cuLimitIx(),
      idemAta(caller, makerOwner, mint),
      idemAta(caller, lendAuth, mint),
      await this.program.methods
        .withdrawCollateral()
        .accountsPartial({
          caller,
          plan: r.plan,
          round,
          lendAuth,
          vaultStaging: ata(mint, lendAuth),
          vaultFToken: market ? ata(market.fTokenMint, lendAuth) : null,
          counterpartyDest: this.makerDest(r, mint),
          rentPayer: r.rentPayer,
          pool: r.makerIsPool ? poolPda(this.programId)[0] : null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(market ? lendMarketMetas(market) : [])
        .instruction(),
    ];
  }

  async unwindRound(caller: PublicKey, round: PublicKey, r: RoundAccount, p: PlanAccount) {
    const escrowMint = "put" in r.kind ? p.assetMint : USDC_MINT;
    const makerOwner = r.makerIsPool ? lendAuthPda(poolPda(this.programId)[0], this.programId)[0] : r.maker;
    return [
      idemAta(caller, makerOwner, escrowMint),
      await this.program.methods
        .unwindRound()
        .accountsPartial({
          plan: r.plan,
          round,
          epoch: r.epoch,
          escrow: escrowPda(round, this.programId)[0],
          makerDest: ata(escrowMint, makerOwner),
          rentPayer: r.rentPayer,
          pool: r.makerIsPool ? poolPda(this.programId)[0] : null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  // ---------- plan updates ----------
  async updatePlan(owner: PublicKey, plan: PublicKey, p: PlanAccount, a: UpdatePlanInput): Promise<TransactionInstruction[]> {
    const [lendAuth] = lendAuthPda(plan, this.programId);
    const exitPhase = "sell" in p.side || ("wheel" in p.side && "exit" in p.phase);
    const mint = exitPhase ? p.assetMint : USDC_MINT;
    const market = lendMarketForMint(mint);
    const opt = (x: bigint | number | undefined | null) => (x === undefined || x === null ? null : bn(x));
    return [
      cuLimitIx(),
      idemAta(owner, owner, mint),
      await this.program.methods
        .updatePlan({
          targetStrike: opt(a.targetStrike),
          band: opt(a.band),
          horizonEnd: opt(a.horizonEnd),
          minPremiumBpsPerDay: a.minPremiumBpsPerDay ?? null,
          sizeTotal: opt(a.sizeTotal),
        })
        .accountsPartial({
          owner,
          config: configPda(this.programId)[0],
          asset: p.asset,
          plan,
          lendAuth,
          ownerCollateral: ata(mint, owner),
          vaultCollateral: ata(mint, lendAuth),
          vaultFToken: market ? ata(market.fTokenMint, lendAuth) : null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(market ? lendMarketMetas(market) : [])
        .instruction(),
    ];
  }

  /** flip_plan (agent): Wheel Accumulate → Exit. */
  async flipPlan(agent: PublicKey, plan: PublicKey, p: PlanAccount): Promise<TransactionInstruction[]> {
    const [lendAuth] = lendAuthPda(plan, this.programId);
    const assetMarket = lendMarketForMint(p.assetMint);
    const ixs = [cuLimitIx(), idemAta(agent, p.owner, USDC_MINT), idemAta(agent, lendAuth, p.assetMint)];
    if (assetMarket) ixs.push(idemAta(agent, lendAuth, assetMarket.fTokenMint));
    ixs.push(
      await this.program.methods
        .flipPlan()
        .accountsPartial({
          agent,
          config: configPda(this.programId)[0],
          plan,
          lendAuth,
          vaultUsdc: ata(USDC_MINT, lendAuth),
          vaultUsdcFToken: ata(LEND_MARKETS.USDC.fTokenMint, lendAuth),
          ownerUsdc: ata(USDC_MINT, p.owner),
          vaultAsset: ata(p.assetMint, lendAuth),
          vaultAssetFToken: assetMarket ? ata(assetMarket.fTokenMint, lendAuth) : null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([...lendMarketMetas(LEND_MARKETS.USDC), ...(assetMarket ? lendMarketMetas(assetMarket) : [])])
        .instruction(),
    );
    return ixs;
  }

  // ---------- pool ----------
  poolAccounts() {
    const [pool] = poolPda(this.programId);
    const [poolAuth] = lendAuthPda(pool, this.programId);
    return {
      pool,
      poolAuth,
      shareMint: poolMintPda(this.programId)[0],
      poolUsdc: ata(USDC_MINT, poolAuth),
      poolWsol: ata(WSOL_MINT, poolAuth),
      poolFToken: ata(LEND_MARKETS.USDC.fTokenMint, poolAuth),
    };
  }

  async initPool(authority: PublicKey, params: PoolParamsInput): Promise<TransactionInstruction[]> {
    const a = this.poolAccounts();
    return [
      idemAta(authority, a.poolAuth, USDC_MINT),
      idemAta(authority, a.poolAuth, WSOL_MINT),
      idemAta(authority, a.poolAuth, LEND_MARKETS.USDC.fTokenMint),
      await this.program.methods
        .initPool(toPoolParams(params))
        .accountsPartial({
          authority,
          config: configPda(this.programId)[0],
          pool: a.pool,
          poolAuth: a.poolAuth,
          shareMint: a.shareMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  setPoolParams(authority: PublicKey, paused: boolean, params: PoolParamsInput) {
    return this.program.methods
      .setPoolParams(paused, toPoolParams(params))
      .accountsPartial({ authority, pool: this.poolAccounts().pool })
      .instruction();
  }

  /** pool_deposit of USDC or WSOL (for WSOL, wrap into the LP's WSOL ATA first). */
  async poolDeposit(lp: PublicKey, mint: PublicKey, amount: bigint | number): Promise<TransactionInstruction[]> {
    const a = this.poolAccounts();
    return [
      idemAta(lp, lp, a.shareMint),
      await this.program.methods
        .poolDeposit(bn(amount))
        .accountsPartial({
          lp,
          pool: a.pool,
          poolAuth: a.poolAuth,
          shareMint: a.shareMint,
          lpShares: ata(a.shareMint, lp),
          mint,
          lpSource: ata(mint, lp),
          poolUsdc: a.poolUsdc,
          poolWsol: a.poolWsol,
          solAsset: assetPda(WSOL_MINT, this.programId)[0],
          spotFeed: PYTH_PUSH_FEEDS.SOL_USD,
          lendingUsdc: LEND_MARKETS.USDC.lending,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  async poolWithdraw(lp: PublicKey, shares: bigint | number): Promise<TransactionInstruction[]> {
    const a = this.poolAccounts();
    return [
      idemAta(lp, lp, USDC_MINT),
      idemAta(lp, lp, WSOL_MINT),
      idemAta(lp, lp, LEND_MARKETS.USDC.fTokenMint),
      await this.program.methods
        .poolWithdraw(bn(shares))
        .accountsPartial({
          lp,
          pool: a.pool,
          poolAuth: a.poolAuth,
          shareMint: a.shareMint,
          lpShares: ata(a.shareMint, lp),
          poolUsdc: a.poolUsdc,
          poolWsol: a.poolWsol,
          poolFToken: a.poolFToken,
          lpUsdc: ata(USDC_MINT, lp),
          lpWsol: ata(WSOL_MINT, lp),
          lpFToken: ata(LEND_MARKETS.USDC.fTokenMint, lp),
          solAsset: assetPda(WSOL_MINT, this.programId)[0],
          spotFeed: PYTH_PUSH_FEEDS.SOL_USD,
          lendingUsdc: LEND_MARKETS.USDC.lending,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  async poolTakeRound(payer: PublicKey, round: PublicKey, r: RoundAccount, p: PlanAccount, asset: AssetAccount, feeRecipient: PublicKey) {
    const a = this.poolAccounts();
    return [
      idemAta(payer, p.owner, USDC_MINT),
      idemAta(payer, feeRecipient, USDC_MINT),
      await this.program.methods
        .poolTakeRound()
        .accountsPartial({
          payer,
          config: configPda(this.programId)[0],
          asset: r.asset,
          plan: r.plan,
          round,
          epoch: r.epoch,
          escrow: escrowPda(round, this.programId)[0],
          spotFeed: asset.spotFeed,
          pool: a.pool,
          poolAuth: a.poolAuth,
          poolUsdc: a.poolUsdc,
          poolWsol: a.poolWsol,
          lendingUsdc: LEND_MARKETS.USDC.lending,
          ownerUsdc: ata(USDC_MINT, p.owner),
          feeUsdc: ata(USDC_MINT, feeRecipient),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  /** pool_lend_idle (lend=true) / pool_unlend (lend=false); signer = pool authority or agent. */
  async poolLend(signer: PublicKey, amount: bigint | number, lend: boolean): Promise<TransactionInstruction[]> {
    const a = this.poolAccounts();
    const m = lend ? this.program.methods.poolLendIdle(bn(amount)) : this.program.methods.poolUnlend(bn(amount));
    return [
      cuLimitIx(),
      await m
        .accountsPartial({
          signer,
          config: configPda(this.programId)[0],
          pool: a.pool,
          poolAuth: a.poolAuth,
          poolUsdc: a.poolUsdc,
          poolFToken: a.poolFToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(lendMarketMetas(LEND_MARKETS.USDC))
        .instruction(),
    ];
  }
}

export interface UpdatePlanInput {
  targetStrike?: bigint | number;
  band?: bigint | number;
  horizonEnd?: number;
  minPremiumBpsPerDay?: number;
  sizeTotal?: bigint | number;
}

export interface PoolParamsInput {
  maxPremiumBpsOfNotional: number;
  maxOpenNotional: bigint | number;
  maxUtilizationBps: number;
  spendWindowSecs: number;
  spendWindowCap: bigint | number;
}

function toPoolParams(p: PoolParamsInput) {
  return {
    maxPremiumBpsOfNotional: p.maxPremiumBpsOfNotional,
    maxOpenNotional: bn(p.maxOpenNotional),
    maxUtilizationBps: p.maxUtilizationBps,
    spendWindowSecs: p.spendWindowSecs,
    spendWindowCap: bn(p.spendWindowCap),
  };
}


export interface AssetParamsInput {
  decimals: number;
  pythFeedIdHex: string;
  spotFeed: PublicKey;
  strikeTick: bigint | number;
  maxConfBps: number;
  maxSpotMoveBps: number;
  maxSpotAgeSecs: number;
  enabled: boolean;
}

function toAssetParams(p: AssetParamsInput) {
  return {
    decimals: p.decimals,
    pythFeedId: Array.from(Buffer.from(p.pythFeedIdHex.replace(/^0x/, ""), "hex")),
    spotFeed: p.spotFeed,
    strikeTick: bn(p.strikeTick),
    maxConfBps: p.maxConfBps,
    maxSpotMoveBps: p.maxSpotMoveBps,
    maxSpotAgeSecs: p.maxSpotAgeSecs,
    enabled: p.enabled,
  };
}

export interface CreatePlanInput {
  nonce: bigint | number;
  side: SideName;
  quick: boolean;
  targetStrike?: bigint | number;
  exitStrike?: bigint | number;
  sizeTotal: bigint | number;
  lockStrike?: boolean;
  band?: bigint | number;
  exitBand?: bigint | number;
  minPremiumBpsPerDay: number;
  maxExpirySecs: number;
  horizonEnd: number;
  maxRoundsPerDay: number;
  /** defaults to ATA(collateral mint, owner) */
  ownerCollateral?: PublicKey;
}

export interface OpenRoundInput {
  strike: bigint | number;
  size: bigint | number;
  auctionSecs: number;
  premiumStart: bigint | number;
  premiumFloor: bigint | number;
  memoHash: Uint8Array | number[];
}
