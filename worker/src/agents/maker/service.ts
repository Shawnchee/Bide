/**
 * Maker agents service: decides one stance per (maker, asset, epoch, round kind) shortly before that epoch's auction
 * window (MAKER_STANCE_LEAD_SECS, default 420 s — well before the quick desk's 180 s lead so stance calls don't sit in
 * the serial GLM queue in front of the desk). Rounds then derive bids instantly from the stored stance (makers/index.ts).
 */
import { randomUUID } from "node:crypto";
import type { ChatTransport } from "../../desk/llm/chat.js";
import type { DeskTools } from "../../desk/types.js";
import { loadEventCalendar } from "../../desk/events.js";
import type { AssetState, ChainSnapshot, EpochState, RoundState } from "../../chain/types.js";
import type { MakerStanceRow, Repo } from "../../db/types.js";
import { logger } from "../../log.js";
import type { AgentConfig } from "../config.js";
import { personaFor } from "./personas.js";
import { decideStance, hashRecord, type StanceContext, type StanceDecision } from "./stance.js";

const log = logger("maker-agents");
const DAY = 86_400;
const STD_OPEN = 28_800; // 08:00 UTC
const STD_WINDOW = 1_800;
const STD_MIN_TO_EXPIRY = 12 * 3_600;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export type RoundKindLc = "put" | "call";
export type StanceEntry = { status: "pending" } | { status: "ready"; row: MakerStanceRow & { id: string } };

export interface MakerInventoryView { usdc: bigint; asset: bigint; openNotional: bigint; maxOpenNotional: bigint }

export interface MakerAgentsDeps {
  repo: Repo;
  /** Already wrapped by the shared LlmQueue. */
  transport: ChatTransport;
  model: string;
  cfg: Pick<AgentConfig, "makerTimeoutMs" | "stanceLeadSecs" | "makerMaxCallsPerHour">;
  tools: Pick<DeskTools, "get_spot" | "price_grid" | "fill_probability" | "venue_dispersion" | "spot_moves">;
  makers: { name: string; pubkey: string }[];
  inventory: (maker: string, s: ChainSnapshot, asset: AssetState) => Promise<MakerInventoryView | null>;
  now?: () => number; // ms
}

export const stanceKey = (assetPk: string, epochPk: string, kind: RoundKindLc) => `${assetPk}:${epochPk}:${kind}`;

/** Which (epoch, kind) pairs need a stance now: an active plan of that kind exists and the epoch's window is near/open. */
export function stanceTargets(s: ChainSnapshot, leadSecs: number): { epoch: EpochState; kind: RoundKindLc }[] {
  const now = s.now;
  const need = new Map<string, Set<RoundKindLc>>();
  for (const p of s.plans) {
    if (p.status !== "Active" || p.paused) continue;
    const kind: RoundKindLc = p.side === "Buy" ? "put" : p.side === "Sell" ? "call" : p.phase === "Accumulate" ? "put" : "call";
    const k = `${p.asset}|${p.quick ? "Quick" : "Std"}`;
    if (!need.has(k)) need.set(k, new Set());
    need.get(k)!.add(kind);
  }
  let w = now - mod(now - STD_OPEN, DAY); // most recent 08:00 UTC
  if (now - w >= STD_WINDOW) w += DAY; // next window
  const out: { epoch: EpochState; kind: RoundKindLc }[] = [];
  for (const e of s.epochs) {
    if (e.status !== "Open" || e.expiry <= now) continue;
    const kinds = need.get(`${e.asset}|${e.kind}`);
    if (!kinds) continue;
    let due: boolean;
    if (e.kind === "Quick") due = now >= e.expiry - 600 - leadSecs && now <= e.expiry - 540;
    else due = now >= w - leadSecs && now <= w + STD_WINDOW && e.expiry - w >= STD_MIN_TO_EXPIRY;
    if (due) for (const kind of kinds) out.push({ epoch: e, kind });
  }
  return out;
}

export class MakerAgents {
  private cache = new Map<string, StanceEntry>();
  private calls: number[] = [];
  private now: () => number;
  constructor(private d: MakerAgentsDeps) { this.now = d.now ?? Date.now; }

  /** Kick off stance decisions that are due (non-blocking; GLM calls run in the shared queue). */
  tick(s: ChainSnapshot): void {
    for (const { epoch, kind } of stanceTargets(s, this.d.cfg.stanceLeadSecs)) {
      const asset = s.assets.find((a) => a.pubkey === epoch.asset);
      if (!asset) continue;
      for (const m of this.d.makers) this.ensure(s, asset, epoch, kind, m.name);
    }
    // Drop cache entries for expired epochs.
    if (this.cache.size > 500) for (const k of [...this.cache.keys()].slice(0, this.cache.size - 500)) this.cache.delete(k);
  }

  /** The stance for this round's epoch/kind; triggers a decision if none exists yet (used by later rounds). */
  lookup(round: RoundState, maker: string, s: ChainSnapshot): StanceEntry | undefined {
    const kind: RoundKindLc = round.kind === "Put" ? "put" : "call";
    const key = `${stanceKey(round.asset, round.epoch, kind)}|${maker}`;
    const e = this.cache.get(key);
    if (e) return e;
    const asset = s.assets.find((a) => a.pubkey === round.asset);
    const epoch = s.epochs.find((x) => x.pubkey === round.epoch);
    if (asset && epoch) this.ensure(s, asset, epoch, kind, maker, round.strike);
    return this.cache.get(key);
  }

  private ensure(s: ChainSnapshot, asset: AssetState, epoch: EpochState, kind: RoundKindLc, maker: string, roundStrike?: bigint) {
    const key = stanceKey(asset.pubkey, epoch.pubkey, kind);
    const ck = `${key}|${maker}`;
    if (this.cache.has(ck)) return;
    this.cache.set(ck, { status: "pending" });
    this.decide(s, asset, epoch, kind, maker, key, roundStrike)
      .then((row) => this.cache.set(ck, { status: "ready", row }))
      .catch((e) => { log.warn("stance failed", { maker, slot: key, err: (e as Error).message }); this.cache.delete(ck); });
  }

  private underQuota(): boolean {
    const cutoff = this.now() - 3_600_000;
    this.calls = this.calls.filter((t) => t > cutoff);
    return this.calls.length < this.d.cfg.makerMaxCallsPerHour;
  }

  private async decide(s: ChainSnapshot, asset: AssetState, epoch: EpochState, kind: RoundKindLc, maker: string, key: string, roundStrike?: bigint): Promise<MakerStanceRow & { id: string }> {
    const existing = await this.d.repo.getMakerStance(key, maker).catch(() => null);
    if (existing?.id) return existing as MakerStanceRow & { id: string };
    const persona = personaFor(maker);
    let ctx: StanceContext | null = null;
    let decision: StanceDecision;
    if (!persona) decision = fallback(`no persona for ${maker}`);
    else if (!this.underQuota()) decision = fallback(`quota guard: ${this.d.cfg.makerMaxCallsPerHour} maker calls per hour`);
    else {
      ctx = await this.context(s, asset, epoch, kind, maker, roundStrike);
      const priced = ctx.price_grid.some((c) => c.fair_usd !== null);
      if (!ctx.spot || !priced) decision = fallback("no market data to decide on (spot or price grid unavailable)");
      else {
        this.calls.push(this.now());
        decision = await decideStance({ transport: this.d.transport, model: this.d.model, persona, ctx, timeoutMs: this.d.cfg.makerTimeoutMs, now: this.now });
      }
    }
    const id = randomUUID();
    const base = {
      stance_key: key, asset: asset.pubkey, epoch_pubkey: epoch.pubkey, expiry: new Date(epoch.expiry * 1000).toISOString(), kind, maker,
      persona: persona?.title ?? "unknown", source: decision.source, model: decision.model, stance: decision.stance, spread_pct: decision.spread_pct,
      thesis: decision.thesis, confidence: decision.confidence, grounded: decision.grounded, fallback_reason: decision.fallback_reason, context: ctx,
      latency_ms: decision.latency_ms, created_at: new Date(this.now()).toISOString(),
    };
    const row = { ...base, id, stance_hash: hashRecord(base as unknown as Record<string, unknown>) };
    log.info("maker stance", { maker, slot: key, source: row.source, stance: row.stance, spread_pct: row.spread_pct, confidence: row.confidence, fallback_reason: row.fallback_reason, latency_ms: row.latency_ms, thesis: row.thesis });
    await this.d.repo.insertMakerStance(row).catch((e) => log.warn("persist stance failed", { err: (e as Error).message }));
    return row;
  }

  /** Public inputs only (see FORBIDDEN_CONTEXT_KEYS). Each tool failure becomes null; nothing is invented. */
  async context(s: ChainSnapshot, asset: AssetState, epoch: EpochState, kind: RoundKindLc, maker: string, roundStrike?: bigint): Promise<StanceContext> {
    const t = this.d.tools;
    const nowS = Math.floor(this.now() / 1000);
    const sym = asset.symbol;
    const spot = await t.get_spot({ asset: sym }).catch(() => null);
    const spotUsd = spot ? Number(BigInt(spot.price)) / 1e6 : null;
    const moves = await t.spot_moves({ asset: sym }).catch(() => null);
    const tick = asset.strikeTick > 0n ? asset.strikeTick : 1_000_000n;
    const strikes = spotUsd ? referenceStrikes(epoch.kind === "Quick" ? "Quick" : "Std", kind, spotUsd, tick) : [];
    // A stance triggered by an open round also prices that round's own strike (public on-chain data, not a plan bound).
    if (roundStrike && roundStrike > 0n) strikes.unshift(roundStrike.toString());
    const uniq = [...new Set(strikes)];
    const size = (10n ** BigInt(asset.decimals)).toString();
    const grid = uniq.length ? await t.price_grid({ asset: sym, kind, strikes: uniq, expiries: [epoch.expiry], size }).catch(() => null) : null;
    const cells: StanceContext["price_grid"] = [];
    for (const strike of uniq) {
      const c = grid?.cells.find((x) => x.strike === strike);
      const fp = c && !c.error ? await t.fill_probability({ asset: sym, kind, strike, expiry: epoch.expiry }).catch(() => null) : null;
      const k = Number(BigInt(strike)) / 1e6;
      cells.push({
        strike_usd: r(k, 4), strike_vs_spot_pct: spotUsd ? r(((k - spotUsd) / spotUsd) * 100, 2) : null,
        fair_usd: c && !c.error ? r(Number(BigInt(c.fair_premium)) / 1e6, 4) : null, bid_usd: c && !c.error ? r(Number(BigInt(c.bid_premium)) / 1e6, 4) : null,
        fair_iv: c?.fair_iv !== undefined ? r(c.fair_iv, 4) : null, fill_probability: fp ? r(fp.probability, 3) : null,
        venues: Array.isArray(c?.venues) ? c!.venues!.length : null, ...(c?.error ? { error: String(c.error).slice(0, 120) } : {}),
      });
    }
    const disp = await t.venue_dispersion({ asset: sym, expiry: epoch.expiry }).catch(() => null);
    const cal = loadEventCalendar();
    const events = cal.events
      .filter((e) => e.at_unix >= nowS && e.at_unix <= epoch.expiry + 2 * DAY)
      .map((e) => ({ name: e.name, kind: String(e.kind), at_utc: e.at_utc, inside_option_life: e.at_unix <= epoch.expiry }));
    const inv = await this.d.inventory(maker, s, asset).catch(() => null);
    const hist = await this.d.repo.listMakerBids({ maker, took: true, limit: 50 }).catch(() => []);
    const settled = hist.filter((h) => h.pnl_usdc !== null && h.pnl_usdc !== undefined);
    const ctx: StanceContext = {
      maker, asset: sym, round_kind: kind,
      epoch: { expiry: epoch.expiry, expiry_utc: new Date(epoch.expiry * 1000).toISOString(), kind: epoch.kind === "Quick" ? "quick" : "std", days_to_expiry: r((epoch.expiry - nowS) / DAY, 3) },
      now_utc: new Date(nowS * 1000).toISOString(),
      spot: spot && spotUsd ? { price_usd: r(spotUsd, 4), age_secs: spot.publish_time ? nowS - spot.publish_time : null } : null,
      spot_moves: moves ? { move_1h_pct: rn(moves.move_1h_pct), move_24h_pct: rn(moves.move_24h_pct), move_7d_pct: rn(moves.move_7d_pct) } : null,
      price_grid: cells,
      venue_dispersion: disp ? { venues_used: disp.venues_used, iv_spread_vol_pts: disp.iv_spread_vol_pts === null ? null : r(disp.iv_spread_vol_pts, 2) } : null,
      events,
      my_inventory: inv ? {
        usdc: r(Number(inv.usdc) / 1e6, 2), asset: r(Number(inv.asset) / 10 ** asset.decimals, 4),
        open_notional_usdc: r(Number(inv.openNotional) / 1e6, 2), max_open_notional_usdc: r(Number(inv.maxOpenNotional) / 1e6, 2),
      } : null,
      my_history: {
        rounds_won: hist.length, settled: settled.length,
        cumulative_pnl_usd: r(settled.reduce((a, h) => a + Number(BigInt(h.pnl_usdc!)) / 1e6, 0), 4),
        last: hist.slice(0, 5).map((h) => ({ my_bid_usd: h.bid ? r(Number(BigInt(h.bid)) / 1e6, 4) : null, pnl_usd: h.pnl_usdc ? r(Number(BigInt(h.pnl_usdc)) / 1e6, 4) : null, source: h.source })),
      },
    };
    return ctx;
  }
}

/**
 * Reference strikes (base units, on tick) for a stance's price grid. They must be strikes a round in this epoch could
 * plausibly use, or every fair is ≈ 0 and the LLM can only pass: a 10-min quick epoch's 1σ move is ≈ 0.2 % (≈ 2–3 SOL
 * ticks), so quick → 1 and 2 ticks out of the money; std (≥ 12 h) → 2 % and 5 % OTM.
 */
export function referenceStrikes(epochKind: "Quick" | "Std", kind: RoundKindLc, spotUsd: number, tick: bigint): string[] {
  const base = BigInt(Math.round(spotUsd * 1e6));
  const down = (x: bigint) => (x / tick) * tick;
  const up = (x: bigint) => { const q = x / tick; return (q * tick < x ? q + 1n : q) * tick; };
  if (epochKind === "Quick") {
    // Nearest OTM tick, then one more (puts below spot, calls above).
    if (kind === "put") { const k1 = down(base - 1n); return [k1, k1 - tick].filter((k) => k > 0n).map(String); }
    const k1 = up(base + 1n);
    return [k1, k1 + tick].map(String);
  }
  const pct = (p: number) => BigInt(Math.round(spotUsd * p * 1e6));
  return kind === "put" ? [down(pct(0.98)), down(pct(0.95))].map(String) : [up(pct(1.02)), up(pct(1.05))].map(String);
}

const rn = (x: number | null | undefined) => (x === null || x === undefined ? null : r(x, 2));

function fallback(reason: string): StanceDecision {
  return { source: "fallback", stance: null, spread_pct: null, thesis: null, confidence: null, grounded: null, model: null, latency_ms: null, fallback_reason: reason };
}
