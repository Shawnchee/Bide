// W-lane implementation of the desk's DeskTools (contract: worker/src/desk/types.ts, notes/desk.md).
// Converts pricer JS numbers ↔ base-unit strings: strike/1e6 → $, size/10^dec → whole asset, expiry×1000 → ms,
// premiums BigInt(Math.round(x)). Pricer failures become cells with `error`.
import { randomUUID } from "node:crypto";
import type { BideChain } from "./chain/client.js";
import type { ChainSnapshot, PlanState } from "./chain/types.js";
import type { DeskTools, PlanView, PriceCell, EpochKind as DeskEpochKind } from "./desk/types.js";
import type { JupiterReference } from "./jupiter/reference.js";
import { quickEpochTargets, stdEpochTargets } from "./keeper/schedule.js";

/** Expiries ≤ 1 h away are quick epochs (quick plans cap max_expiry at 1 h; std rounds need ≥ 12 h). */
export const isQuickHorizon = (expiry: number, now: number) => expiry - now <= 3_600;
import { FEED_IDS, getHistoricalPrice } from "./pyth/hermes.js";
import type { Pricer, PricerAsset } from "./pricer/index.js";
import type { Repo } from "./db/types.js";
import { OUTCOMES_GUIDANCE, outcomeStats } from "./agents/outcomes.js";

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const DECIMALS: Record<PricerAsset, number> = { SOL: 9, BTC: 8 };

/** Draft plan from the /earn form, in base units like create_plan (preview only). */
export interface PlanDraft {
  owner?: string;
  asset: PricerAsset;
  side: "buy" | "sell" | "wheel";
  quick: boolean;
  target_strike: string;
  exit_strike?: string;
  lock_strike: boolean;
  band?: string;
  exit_band?: string;
  size_total: string;
  min_premium_bps_per_day: number;
  max_expiry_secs: number;
  horizon_end: number;
  max_rounds_per_day?: number;
}

const usdToU64 = (usd: number) => BigInt(Math.round(usd * 1e6)).toString();
const lc = <T extends string>(s: string) => s.toLowerCase() as T;

export interface DeskToolsDeps {
  pricer: Pricer;
  jupiter: JupiterReference;
  /** Latest chain snapshot (null before the program is live). */
  getSnapshot: () => Promise<ChainSnapshot | null>;
  chain: BideChain | null;
  feeBpsFallback?: number; // BUILD default 1000 when Config is unreadable (preview before deploy)
  now?: () => number; // ms
}

export class WorkerDeskTools implements DeskTools {
  private drafts = new Map<string, PlanDraft>();
  private outcomes: { repo: Repo; makerNames: () => Record<string, string> } | null = null;
  /** Enable the desk's recent_outcomes tool (rounds mirror + maker pubkey → name map). */
  setOutcomeSource(repo: Repo, makerNames: () => Record<string, string>) { this.outcomes = { repo, makerNames }; }

  async recent_outcomes({ plan_id, asset, limit }: { plan_id: string; asset: string; limit: number }) {
    if (!this.outcomes) return { plan: null, asset: null, guidance: OUTCOMES_GUIDANCE, note: "no outcome history is available" };
    const snap = await this.d.getSnapshot();
    const sym = this.assetSymbol(snap, asset);
    const assetPk = snap?.assets.find((a) => a.symbol === sym)?.pubkey ?? null;
    const names = this.outcomes.makerNames();
    const isDraft = plan_id.startsWith("draft:");
    const [planRows, assetRows] = await Promise.all([
      isDraft ? Promise.resolve([]) : this.outcomes.repo.listRounds({ plan: plan_id, limit }),
      assetPk ? this.outcomes.repo.listRounds({ asset: assetPk, limit }) : Promise.resolve([]),
    ]);
    return {
      plan: isDraft ? { note: "draft plan: no rounds yet" } : outcomeStats(planRows, names),
      asset: { asset: sym, ...outcomeStats(assetRows, names) },
      guidance: OUTCOMES_GUIDANCE,
    };
  }
  private moveCache = new Map<string, { at: number; v: any }>();
  constructor(private d: DeskToolsDeps) {}
  setChain(c: BideChain | null) { this.d.chain = c; }

  /** Register a draft for preview; returns a plan_id the desk can pass to get_plan. */
  registerDraft(draft: PlanDraft): string {
    const id = `draft:${randomUUID()}`;
    this.drafts.set(id, draft);
    setTimeout(() => this.drafts.delete(id), 30 * 60_000).unref?.();
    return id;
  }

  private assetSymbol(snap: ChainSnapshot | null, assetPkOrSym: string): PricerAsset {
    if (assetPkOrSym === "SOL" || assetPkOrSym === "BTC") return assetPkOrSym;
    return (snap?.assets.find((a) => a.pubkey === assetPkOrSym)?.symbol ?? "SOL") as PricerAsset;
  }

  private openEpochs(snap: ChainSnapshot | null, sym: PricerAsset): PlanView["open_epochs"] {
    const now = Math.floor((this.d.now ?? Date.now)() / 1000);
    if (!snap) {
      // Program not live yet (preview only): the scheduled epochs the keeper would open, without pubkeys.
      return [...stdEpochTargets(now).map((e) => ({ expiry: e, kind: "std" as DeskEpochKind })), ...quickEpochTargets(now).map((e) => ({ expiry: e, kind: "quick" as DeskEpochKind }))];
    }
    const assetPk = snap.assets.find((a) => a.symbol === sym)?.pubkey;
    return snap.epochs.filter((e) => e.asset === assetPk && (e.status === "Open" || e.status === "Sampling") && e.expiry > now)
      .map((e) => ({ expiry: e.expiry, kind: lc<DeskEpochKind>(e.kind), pubkey: e.pubkey })).sort((a, b) => a.expiry - b.expiry);
  }

  async get_plan({ plan_id }: { plan_id: string }): Promise<PlanView> {
    const snap = await this.d.getSnapshot();
    const fee_bps = snap?.config.feeBps ?? this.d.feeBpsFallback ?? 1000;
    const draft = this.drafts.get(plan_id);
    if (draft) return this.draftView(plan_id, draft, snap, fee_bps);
    const p = snap?.plans.find((x) => x.pubkey === plan_id);
    if (!p) throw new Error(`plan ${plan_id} not found on-chain`);
    const a = snap!.assets.find((x) => x.pubkey === p.asset)!;
    return planView(p, a.symbol, a.mint, a.decimals, a.strikeTick.toString(), fee_bps, this.openEpochs(snap, a.symbol));
  }

  private draftView(id: string, d: PlanDraft, snap: ChainSnapshot | null, fee_bps: number): PlanView {
    const t = BigInt(d.target_strike), band = BigInt(d.band ?? "0"), ex = BigInt(d.exit_strike ?? "0"), exb = BigInt(d.exit_band ?? "0");
    const a = snap?.assets.find((x) => x.symbol === d.asset);
    const lock = d.lock_strike;
    return {
      plan_id: id, owner: d.owner ?? "draft", asset: d.asset, asset_mint: a?.mint ?? (d.asset === "SOL" ? WSOL : "tBTC"), asset_decimals: DECIMALS[d.asset],
      side: d.side, phase: d.side === "sell" ? "exit" : "accumulate", quick: d.quick, target_strike: t.toString(), exit_strike: ex.toString(), lock_strike: lock,
      strike_min: (lock ? t : t - band).toString(), strike_max: t.toString(), call_strike_min: ex.toString(), call_strike_max: (lock ? ex : ex + exb).toString(),
      strike_tick: a?.strikeTick.toString() ?? (d.asset === "SOL" ? "1000000" : "250000000"), size_total: d.size_total, size_filled: "0",
      collateral_principal: "0", min_premium_bps_per_day: d.min_premium_bps_per_day, max_expiry_secs: d.max_expiry_secs, horizon_end: d.horizon_end,
      max_rounds_per_day: d.max_rounds_per_day ?? (d.quick ? 30 : 6), rounds_today: 0, paused: false, status: "active", active_round: null, pending_settlement: null,
      fee_bps, open_epochs: this.openEpochs(snap, d.asset), draft: true,
    };
  }

  async get_spot({ asset }: { asset: string }) {
    const sym = this.assetSymbol(await this.d.getSnapshot(), asset);
    let st = this.d.pricer.get(sym);
    if (!st?.spot || (this.d.now ?? Date.now)() - st.refreshedAt > 25_000) st = await this.d.pricer.refresh(sym);
    if (!st.spot) throw new Error("no Pyth spot");
    return { asset: sym, price: usdToU64(st.spot.price), conf: usdToU64(st.spot.conf), publish_time: st.spot.publishTime, source: "pyth-hermes" };
  }

  async price_grid(args: { asset: string; kind: "put" | "call"; strikes: string[]; expiries: number[]; size: string }) {
    const sym = this.assetSymbol(await this.d.getSnapshot(), args.asset);
    const sizeWhole = Number(BigInt(args.size)) / 10 ** DECIMALS[sym];
    // Quick epochs are ≤ 1 h out (quick plans' max_expiry); std rounds need ≥ 12 h. Was "≤ 600 s", which mis-priced
    // the next quick epoch as std (no venue → desk skip) whenever the desk ran in its 90 s lead (integration 2026-10-06 05:49).
    const quick = (e: number) => isQuickHorizon(e, Math.floor((this.d.now ?? Date.now)() / 1000));
    const cells: PriceCell[] = [];
    for (const expiry of args.expiries) for (const s of args.strikes) {
      const r = await this.d.pricer.quote(sym, args.kind, Number(BigInt(s)) / 1e6, expiry * 1000, sizeWhole, quick(expiry));
      if (!r.ok) { cells.push({ strike: s, expiry, fair_premium: "0", bid_premium: "0", premium_start: "0", premium_floor: "0", error: r.reason, rejected: r.rejected }); continue; }
      cells.push({
        strike: s, expiry, fair_premium: String(BigInt(Math.round(r.fairPremium))), bid_premium: String(BigInt(Math.round(r.bidPremium))),
        premium_start: String(BigInt(Math.round(r.start))), premium_floor: String(BigInt(Math.round(r.floor))), fair_iv: r.fairIv, bid_iv: r.bidIv,
        venues: r.venues.map((v) => ({ venue: v.venue, mid_iv: v.midIv, bid_iv: v.bidIv, method: v.method })), quick_pricing: r.quick_pricing,
        floor_raised: r.floorRaised, rejected_venues: r.rejected,
      });
    }
    const spot = this.d.pricer.get(sym)?.spot?.price ?? 0;
    return { asset: sym, kind: args.kind, size: args.size, spot: usdToU64(spot), cells };
  }

  async fill_probability(args: { asset: string; kind: "put" | "call"; strike: string; expiry: number }) {
    const sym = this.assetSymbol(await this.d.getSnapshot(), args.asset);
    const quick = isQuickHorizon(args.expiry, Math.floor((this.d.now ?? Date.now)() / 1000));
    const r = await this.d.pricer.quote(sym, args.kind, Number(BigInt(args.strike)) / 1e6, args.expiry * 1000, 1, quick);
    if (!r.ok) throw new Error(`cannot price: ${r.reason}`);
    return { asset: sym, strike: args.strike, expiry: args.expiry, kind: args.kind, probability: r.fillProbability, iv: r.fairIv, quick_pricing: r.quick_pricing };
  }

  async lend_apy({ mint }: { mint: string }) {
    const ref = await this.d.jupiter.get60s();
    const mainMint = mint === USDC_DEVNET ? USDC_MAINNET : mint;
    const hit = ref?.lend.find((l) => l.mint === mainMint);
    // devnet APY from the on-chain exchange rate needs the Lend reserve read (P lane's Lend helpers) — null until wired.
    return { mint, devnet_apy_bps: null, mainnet_reference_apy_bps: hit ? hit.totalBps : null, label: "mainnet reference" };
  }

  async venue_dispersion({ asset, expiry }: { asset: string; expiry: number }) {
    const sym = this.assetSymbol(await this.d.getSnapshot(), asset);
    let st = this.d.pricer.get(sym);
    if (!st?.spot) st = await this.d.pricer.refresh(sym);
    const atm = Math.round(st.spot?.price ?? 0);
    const quick = isQuickHorizon(expiry, Math.floor((this.d.now ?? Date.now)() / 1000));
    const r = await this.d.pricer.quote(sym, "put", atm, expiry * 1000, 1, quick);
    const ivs = (r.venues ?? []).map((v) => v.midIv);
    const now = (this.d.now ?? Date.now)();
    const ages = (st.snapshots ?? []).filter((s) => r.venues.some((v) => v.venue === s.venue)).flatMap((s) => s.quotes.map((q) => (now - q.ts) / 1000));
    return {
      asset: sym, expiry, venues_used: ivs.length,
      iv_spread_vol_pts: ivs.length >= 2 ? +((Math.max(...ivs) - Math.min(...ivs)) * 100).toFixed(3) : null,
      max_quote_age_secs: ages.length ? Math.round(Math.min(Math.max(...ages), 3600)) : null,
      per_venue: r.venues.map((v) => ({ venue: v.venue, mid_iv: v.midIv })), rejected: r.rejected, at_strike_usd: atm,
    };
  }

  async spot_moves({ asset }: { asset: string }) {
    const sym = this.assetSymbol(await this.d.getSnapshot(), asset);
    const c = this.moveCache.get(sym);
    if (c && Date.now() - c.at < 5 * 60_000) return c.v;
    const spot = (await this.get_spot({ asset: sym })).price;
    const now = Math.floor((this.d.now ?? Date.now)() / 1000);
    const cur = Number(BigInt(spot)) / 1e6;
    const pct = async (ago: number) => {
      try { const p = await getHistoricalPrice(FEED_IDS[sym], now - ago); return +(((cur - p.price) / p.price) * 100).toFixed(3); } catch { return null; }
    };
    const v = { asset: sym, move_1h_pct: await pct(3600), move_24h_pct: await pct(86_400), move_7d_pct: await pct(7 * 86_400), source: "pyth-hermes" };
    this.moveCache.set(sym, { at: Date.now(), v });
    return v;
  }
}

export function planView(p: PlanState, sym: string, mint: string, decimals: number, tick: string, fee_bps: number, open_epochs: PlanView["open_epochs"]): PlanView {
  return {
    plan_id: p.pubkey, owner: p.owner, asset: sym, asset_mint: mint, asset_decimals: decimals, side: lc(p.side), phase: lc(p.phase), quick: p.quick,
    target_strike: p.targetStrike.toString(), exit_strike: p.exitStrike.toString(), lock_strike: p.lockStrike, strike_min: p.strikeMin.toString(),
    strike_max: p.strikeMax.toString(), call_strike_min: p.callStrikeMin.toString(), call_strike_max: p.callStrikeMax.toString(), strike_tick: tick,
    size_total: p.sizeTotal.toString(), size_filled: p.sizeFilled.toString(), collateral_principal: p.collateralPrincipal.toString(),
    min_premium_bps_per_day: p.minPremiumBpsPerDay, max_expiry_secs: p.maxExpirySecs, horizon_end: p.horizonEnd, max_rounds_per_day: p.maxRoundsPerDay,
    rounds_today: p.roundsToday, paused: p.paused, status: lc(p.status), active_round: p.activeRound, pending_settlement: p.pendingSettlement, fee_bps, open_epochs,
  };
}
