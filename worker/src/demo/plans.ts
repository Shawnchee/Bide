// Devnet demo plan keeper (opt-in: DEMO_OWNER_KEYPAIR). Keeps one quick BUY and one quick SELL plan, owned by a dedicated
// devnet demo wallet, active near spot, so 10-min rounds keep flowing for the demo history. A quick plan stops for good
// once a round is exercised (size fully filled), and a locked strike that spot has left behind makes the desk skip every
// window — so: re-create a plan when the side has none, and close + re-create an idle plan whose strike drifted > 0.5 %.
// These plans are labelled demo/test plans (owner = the demo wallet in WALLETS.md); they are not user activity.
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { ata, BIDE_ALT, BideClient, LEND_DUST_BUFFER, USDC_MINT, WSOL_MINT } from "@bide/shared";
import type { ChainSnapshot, PlanState } from "../chain/types.js";
import { sendAndConfirm } from "../chain/send.js";
import { logger } from "../log.js";

const log = logger("demo-plans");

export interface DemoPlanOpts {
  sizeLamports: bigint; // per plan, e.g. 0.05 SOL
  horizonSecs: number; // plan horizon, e.g. 4 h
  driftBps: number; // close + re-create an idle plan whose strike is further than this from spot
  minBps: number; // min_premium_bps_per_day
}
export const DEFAULT_DEMO_OPTS: DemoPlanOpts = { sizeLamports: 50_000_000n, horizonSecs: 4 * 3600, driftBps: 50, minBps: 10 };

export type DemoAction =
  | { type: "create"; side: "buy" | "sell"; strike: bigint }
  | { type: "close"; plan: string; reason: string };

/** Pure decision: what to do for the demo owner's quick plans now. `spot` in USDC base units. */
export function planDemoActions(s: Pick<ChainSnapshot, "plans" | "assets">, owner: string, spot: bigint, now: number, o: DemoPlanOpts = DEFAULT_DEMO_OPTS): DemoAction[] {
  const asset = s.assets.find((a) => a.symbol === "SOL");
  if (!asset || spot <= 0n) return [];
  const tick = asset.strikeTick;
  const out: DemoAction[] = [];
  for (const side of ["buy", "sell"] as const) {
    const live = s.plans.filter((p) => p.owner === owner && p.quick && p.asset === asset.pubkey && p.status === "Active" && (side === "buy" ? p.side === "Buy" : p.side === "Sell") && now < p.horizonEnd - 600);
    // Buy (puts): nearest tick at/below spot. Sell (calls): nearest tick at/above spot. Near the money → the desk can price it.
    const strike = side === "buy" ? (spot / tick) * tick : ((spot + tick - 1n) / tick) * tick;
    if (live.length === 0) { out.push({ type: "create", side, strike }); continue; }
    for (const p of live) {
      const k = side === "buy" ? p.targetStrike : p.exitStrike;
      const drift = Number(((k > spot ? k - spot : spot - k) * 10_000n) / spot);
      const idle = !p.activeRound && !p.pendingSettlement && p.sizeFilled === 0n;
      if (idle && drift > o.driftBps) out.push({ type: "close", plan: p.pubkey, reason: `strike ${Number(k) / 1e6} is ${drift} bps from spot ${Number(spot) / 1e6}` });
    }
  }
  return out;
}

export class DemoPlans {
  private client: BideClient;
  private lastCreate = new Map<string, number>();
  constructor(private connection: Connection, programId: PublicKey, private owner: Keypair, private spot: () => Promise<number | null>, private o: DemoPlanOpts = DEFAULT_DEMO_OPTS) {
    this.client = new BideClient(connection, programId);
    log.info("demo plans on", { owner: owner.publicKey.toBase58(), sizeSol: Number(o.sizeLamports) / 1e9, horizonH: o.horizonSecs / 3600, driftBps: o.driftBps });
  }

  async tick(s: ChainSnapshot | null): Promise<void> {
    if (!s || s.config.paused) return;
    const spotUsd = await this.spot();
    if (!spotUsd) return;
    const spot = BigInt(Math.round(spotUsd * 1e6));
    const now = s.now;
    // Don't act inside a quick auction window or the desk lead before it (E−690 … E−540): it would race the keeper.
    const inEpoch = ((now % 600) + 600) % 600; // seconds since the last 10-min boundary
    if (inEpoch < 90 || inEpoch >= 510) return;
    for (const a of planDemoActions(s, this.owner.publicKey.toBase58(), spot, now, this.o)) {
      try {
        if (a.type === "close") await this.close(new PublicKey(a.plan), a.reason);
        else if (Date.now() - (this.lastCreate.get(a.side) ?? 0) > 120_000) { this.lastCreate.set(a.side, Date.now()); await this.create(a.side, a.strike, now); }
      } catch (e) {
        log.warn("demo plan action failed", { action: { ...a, strike: "strike" in a ? a.strike.toString() : undefined }, err: (e as Error).message.slice(0, 300) });
      }
    }
  }

  private alt() { return this.connection.getAddressLookupTable(BIDE_ALT).then((r) => (r.value ? [r.value] : [])); }

  private async close(plan: PublicKey, reason: string) {
    const p = await this.client.fetchPlan(plan);
    const sig = await sendAndConfirm(this.connection, this.owner, await this.client.closePlan(this.owner.publicKey, plan, p, false), [], { alts: await this.alt(), cu: 400_000 });
    log.info("demo plan closed", { plan: plan.toBase58(), reason, sig });
  }

  private async create(side: "buy" | "sell", strike: bigint, now: number) {
    const me = this.owner.publicKey;
    const size = this.o.sizeLamports;
    const pre = [];
    if (side === "buy") {
      // Exercised puts left WSOL in the owner's ATA: unwrap it (lamports back) so SOL is available for the next sell plan.
      const wsol = await this.connection.getTokenAccountBalance(ata(WSOL_MINT, me)).then((r) => BigInt(r.value.amount)).catch(() => -1n);
      if (wsol >= 0n) pre.push(createCloseAccountInstruction(ata(WSOL_MINT, me), me, me));
      const usdc = await this.connection.getTokenAccountBalance(ata(USDC_MINT, me)).then((r) => BigInt(r.value.amount)).catch(() => 0n);
      const need = (strike * size) / 1_000_000_000n + 1_000n;
      if (usdc < need) { log.warn("demo owner short of USDC for a buy plan", { have: usdc.toString(), need: need.toString() }); return; }
    } else {
      const lamports = BigInt(await this.connection.getBalance(me));
      if (lamports < size + 50_000_000n) { log.warn("demo owner short of SOL for a sell plan", { lamports: lamports.toString() }); return; }
      const wsolAta = ata(WSOL_MINT, me);
      pre.push(
        createAssociatedTokenAccountIdempotentInstruction(me, wsolAta, me, WSOL_MINT),
        SystemProgram.transfer({ fromPubkey: me, toPubkey: wsolAta, lamports: size + LEND_DUST_BUFFER }),
        createSyncNativeInstruction(wsolAta),
      );
    }
    const { ixs, plan } = await this.client.createPlan(me, WSOL_MINT, {
      nonce: BigInt(Date.now()), side, quick: true,
      targetStrike: side === "buy" ? strike : 0n, exitStrike: side === "sell" ? strike : 0n,
      sizeTotal: size, minPremiumBpsPerDay: this.o.minBps, maxExpirySecs: 3600, horizonEnd: now + this.o.horizonSecs, maxRoundsPerDay: 30,
    });
    // Close the WSOL ATA before create_plan (buy) / wrap before it (sell); keep any CU-limit ix the builder put first.
    const sig = await sendAndConfirm(this.connection, this.owner, [...pre, ...ixs], [], { alts: await this.alt(), cu: 400_000 });
    log.info("demo plan created", { plan: plan.toBase58(), side, strike: Number(strike) / 1e6, sizeSol: Number(size) / 1e9, sig });
  }
}
