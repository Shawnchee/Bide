/**
 * Tool layer: JSON-schema definitions shown to the Quant + a toolbox that executes them through
 * W's `DeskTools` (pricer/RPC), adds deterministic derived fields (so the LLM never does math),
 * serves `event_calendar` from the static file, and records a trace of every call.
 *
 * Honesty rule: derived fields describe the plan and the market; nothing here filters or clamps
 * a candidate to the plan bounds. Out-of-bounds epochs/strikes stay visible to the Quant.
 */
import type { ToolDef } from "./llm/chat.js";
import type { DeskTools, PlanView, PriceGrid, RoundKind, SpotView, ToolTrace } from "./types.js";
import { loadEventCalendar } from "./events.js";
import { notional, pctChange, pow10, ratio, usd, usdPrice, userMinPremiumFloor, formatUnits } from "./units.js";
import { errorMessage } from "./errors.js";
import { QUICK_DESK_LEAD_SECS } from "../keeper/plan.js";
import { pricingNowSecs } from "../keeper/schedule.js";

/** Circle devnet USDC (BUILD §2). Collateral mint for put rounds. */
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const u64Str = { type: "string", pattern: "^[0-9]+$", description: "u64 in base units as a decimal string" };

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_plan",
      description:
        "The user's plan as stored on-chain: side, target price, size goal and progress, deadline, minimum yield, platform fee, the epochs open on-chain, plus derived helpers (round kind, remaining size, ladder size options, distance band once spot is known). Call this first.",
      parameters: { type: "object", properties: { plan_id: { type: "string", description: "Plan pubkey (defaults to the plan being run)" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_spot",
      description: "Current Pyth spot price for an asset (USDC base units per 1 whole asset) and its confidence.",
      parameters: { type: "object", properties: { asset: { type: "string", enum: ["SOL", "BTC"] } }, required: ["asset"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "price_grid",
      description:
        "Premium for each (strike, expiry) cell for a given size, from real CEX options quotes (consensus of >= 2 venues). Per cell: fair, bid, auction start and floor (USDC base units, totals for the size), the user's minimum acceptable floor after fee for that expiry, and how far the floor clears it. Also returns the distance band (how far the target is from spot) and candidate expiries in that band.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", enum: ["SOL", "BTC"] },
          strikes: { type: "array", items: u64Str, minItems: 1, maxItems: 8, description: "USDC base units per 1 whole asset" },
          expiries: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 8, description: "unix seconds of epoch expiries" },
          size: { ...u64Str, description: "asset base units for this round" },
        },
        required: ["asset", "strikes", "expiries", "size"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_probability",
      description: "Probability (from consensus implied vol) that the round is exercised at expiry, i.e. the user buys (or sells) at the strike.",
      parameters: {
        type: "object",
        properties: { asset: { type: "string", enum: ["SOL", "BTC"] }, strike: u64Str, expiry: { type: "integer" } },
        required: ["asset", "strike", "expiry"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lend_apy",
      description: "Jupiter Lend APY for the collateral mint: devnet APY from the on-chain exchange rate, and the mainnet reference APY (labelled).",
      parameters: { type: "object", properties: { mint: { type: "string", description: "token mint (defaults to the plan's collateral mint)" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "venue_dispersion",
      description: "How much the CEX venues disagree on implied vol for an expiry, how many venues passed the filters, and quote age. A data-quality signal.",
      parameters: { type: "object", properties: { asset: { type: "string", enum: ["SOL", "BTC"] }, expiry: { type: "integer" } }, required: ["asset", "expiry"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "spot_moves",
      description: "Realised spot moves over 1h / 24h / 7d, in percent.",
      parameters: { type: "object", properties: { asset: { type: "string", enum: ["SOL", "BTC"] } }, required: ["asset"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_outcomes",
      description:
        "Deterministic statistics of past rounds for this plan and for its asset: rounds, fill rate, fill price / auction start, seconds to fill, untaken count, exercise rate, which maker won, plus the last rounds. Use it to tune auction_secs, expiry, size or skip. It never changes the user's limits or the strike.",
      parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "rounds to consider per scope (default 20)" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "event_calendar",
      description: "Upcoming scheduled US macro events (FOMC, CPI, jobs report) from a static calendar curated from official sources, with UTC times.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.function.name);

export type DistanceBand = { label: "1-2 days" | "about 1 week" | "2-4 weeks" | "quick (10 min)"; min_days: number; max_days: number };

/** SPEC §6 bands: target within 3% of spot → 1–2 days; 3–8% → ~1 week; > 8% → 2–4 weeks. */
export function distanceBand(distancePct: number, quick: boolean): DistanceBand {
  if (quick) return { label: "quick (10 min)", min_days: 0, max_days: 1 };
  const d = Math.abs(distancePct);
  if (d < 3) return { label: "1-2 days", min_days: 1, max_days: 2 };
  if (d <= 8) return { label: "about 1 week", min_days: 5, max_days: 9 };
  return { label: "2-4 weeks", min_days: 14, max_days: 28 };
}

export function roundKindOf(plan: Pick<PlanView, "side" | "phase">): RoundKind {
  if (plan.side === "buy") return "put";
  if (plan.side === "sell") return "call";
  return plan.phase === "accumulate" ? "put" : "call";
}

/** The user's price for the current round kind (target for puts, exit for calls). */
export function userPriceOf(plan: PlanView): string {
  return roundKindOf(plan) === "put" ? plan.target_strike : plan.exit_strike;
}

export interface ToolboxOptions {
  tools: DeskTools;
  planId: string;
  now: () => number; // unix ms
}

/**
 * Executes tool calls for one desk run. Keeps the latest plan/spot/grid so derived fields can be
 * computed deterministically, and records every call in `traces`.
 */
export class Toolbox {
  readonly traces: ToolTrace[] = [];
  plan: PlanView | null = null;
  spot: SpotView | null = null;
  attempt = 0;
  private seq = 0;

  constructor(private readonly opts: ToolboxOptions) {}

  async call(name: string, rawArgs: unknown, callId?: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const started = this.opts.now();
    const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
    const trace: ToolTrace = { call_id: callId ?? `t${this.seq}`, name, args, ok: false, started_at: started, duration_ms: 0, attempt: this.attempt };
    this.seq++;
    try {
      const result = await this.dispatch(name, args);
      trace.ok = true;
      trace.result = result;
      return { ok: true, result };
    } catch (e) {
      trace.error = errorMessage(e);
      return { ok: false, error: trace.error };
    } finally {
      trace.duration_ms = this.opts.now() - started;
      this.traces.push(trace);
    }
  }

  private nowSecs() {
    return Math.floor(this.opts.now() / 1000);
  }

  private async ensurePlan(): Promise<PlanView> {
    if (!this.plan) this.plan = await this.opts.tools.get_plan({ plan_id: this.opts.planId });
    return this.plan;
  }

  private async dispatch(name: string, a: Record<string, unknown>): Promise<unknown> {
    const t = this.opts.tools;
    switch (name) {
      case "get_plan": {
        const planId = typeof a.plan_id === "string" && a.plan_id ? a.plan_id : this.opts.planId;
        const plan = await t.get_plan({ plan_id: planId });
        if (planId === this.opts.planId) this.plan = plan;
        return this.enrichPlan(plan);
      }
      case "get_spot": {
        const spot = await t.get_spot({ asset: String(a.asset ?? (await this.ensurePlan()).asset) });
        if (!this.plan || spot.asset === this.plan.asset) this.spot = spot;
        return { ...spot, price_usd: usdPrice(spot.price), conf_usd: usd(spot.conf), age_secs: this.nowSecs() - spot.publish_time };
      }
      case "price_grid": {
        const plan = await this.ensurePlan();
        const asset = String(a.asset ?? plan.asset);
        const kind = roundKindOf(plan);
        const strikes = (Array.isArray(a.strikes) ? a.strikes : []).map((s) => String(s));
        const expiries = (Array.isArray(a.expiries) ? a.expiries : []).map((x) => Number(x));
        const size = String(a.size ?? "");
        if (!strikes.length || !expiries.length || !/^\d+$/.test(size)) throw new Error("price_grid needs strikes[], expiries[] and size (base units)");
        const grid = await t.price_grid({ asset, kind, strikes, expiries, size });
        if (!this.spot && grid.spot) this.spot = { asset, price: grid.spot, conf: "0", publish_time: this.nowSecs(), source: "price_grid" };
        return this.enrichGrid(plan, grid);
      }
      case "fill_probability": {
        const plan = await this.ensurePlan();
        return t.fill_probability({ asset: String(a.asset ?? plan.asset), kind: roundKindOf(plan), strike: String(a.strike), expiry: Number(a.expiry) });
      }
      case "lend_apy": {
        const plan = await this.ensurePlan();
        const mint = typeof a.mint === "string" && a.mint ? a.mint : roundKindOf(plan) === "put" ? USDC_MINT : plan.asset_mint;
        return t.lend_apy({ mint });
      }
      case "venue_dispersion":
        return t.venue_dispersion({ asset: String(a.asset ?? (await this.ensurePlan()).asset), expiry: Number(a.expiry) });
      case "spot_moves":
        return t.spot_moves({ asset: String(a.asset ?? (await this.ensurePlan()).asset) });
      case "recent_outcomes": {
        const plan = await this.ensurePlan();
        const limit = Math.min(Math.max(Number(a.limit ?? 20) || 20, 1), 50);
        if (!t.recent_outcomes) return { plan: null, asset: null, note: "no outcome history is available to the desk in this deployment" };
        return t.recent_outcomes({ plan_id: this.opts.planId, asset: plan.asset, limit });
      }
      case "event_calendar": {
        const cal = loadEventCalendar();
        const now = this.nowSecs();
        return {
          checked_at: cal.checked_at,
          sources: cal.sources,
          now_utc: new Date(now * 1000).toISOString(),
          events: cal.events.filter((e) => e.at_unix >= now - 86_400).map((e) => ({ ...e, days_from_now: Math.round(((e.at_unix - now) / 86_400) * 10) / 10 })),
        };
      }
      default:
        throw new Error(`unknown tool "${name}" (available: ${TOOL_NAMES.join(", ")})`);
    }
  }

  enrichPlan(plan: PlanView) {
    const kind = roundKindOf(plan);
    const remaining = BigInt(plan.size_total) - BigInt(plan.size_filled);
    const grain = plan.asset_decimals >= 3 ? pow10(plan.asset_decimals - 3) : 1n; // ladder sizes snapped to 0.001 asset
    const frac = (n: bigint) => {
      const v = ((remaining / n) / grain) * grain;
      return (v > 0n ? v : remaining).toString();
    };
    const now = this.nowSecs();
    const userPrice = userPriceOf(plan);
    const epochs = plan.open_epochs
      // Only epochs open_round can target from this run: quick → the one whose auction window [E−600, E−540] is open or
      // opens within the desk lead (QUICK_DESK_LEAD_SECS) (a later epoch's window is ≥ 10 min away — 05:51 run proposed 06:20) and not closed (the desk
      // starts up to 90 s early, when the previous epoch is still "nearest" but no longer openable — integration
      // 2026-10-06 05:39 WindowMissed); std → ≥ 12 h to expiry.
      .filter((e) => e.kind === (plan.quick ? "quick" : "std") && (plan.quick ? e.expiry - 540 > now && e.expiry - 600 - QUICK_DESK_LEAD_SECS <= now : e.expiry - now >= 43_200))
      .sort((x, y) => x.expiry - y.expiry)
      .map((e) => ({ expiry: e.expiry, expiry_utc: new Date(e.expiry * 1000).toISOString(), days_from_now: Math.round(((e.expiry - now) / 86_400) * 100) / 100 }));
    const derived: Record<string, unknown> = {
      round_kind: kind,
      user_price: userPrice,
      user_price_usd: usdPrice(userPrice),
      size_remaining: remaining.toString(),
      size_remaining_human: formatUnits(remaining, plan.asset_decimals),
      ladder_size_options: { all_remaining: remaining.toString(), half: frac(2n), third: frac(3n) },
      epochs_matching_plan_kind: epochs,
      horizon_end_utc: new Date(plan.horizon_end * 1000).toISOString(),
      fee_pct: plan.fee_bps / 100,
    };
    if (this.spot && this.spot.asset === plan.asset) {
      const dist = pctChange(BigInt(this.spot.price), BigInt(userPrice)) ?? 0;
      const band = distanceBand(dist, plan.quick);
      derived.distance = { spot: this.spot.price, spot_usd: usdPrice(this.spot.price), user_price_vs_spot_pct: dist, band };
    }
    return { ...plan, derived };
  }

  enrichGrid(plan: PlanView, grid: PriceGrid) {
    const now = this.nowSecs();
    const userPrice = userPriceOf(plan);
    const dist = grid.spot ? pctChange(BigInt(grid.spot), BigInt(userPrice)) ?? 0 : null;
    const band = dist === null ? null : distanceBand(dist, plan.quick);
    const cells = grid.cells.map((c) => {
      if (c.error) return c;
      // Same reference as price_grid: a quick round lives from its window open (expiry − 600), so the on-chain
      // user-min check sees ≤ 600 s; using that (not the desk's ~780 s lead) keeps floor_over_user_min honest and still safe.
      const secs = c.expiry - pricingNowSecs(plan.quick, c.expiry, now);
      const n = notional(c.strike, grid.size, plan.asset_decimals, "down");
      const userMin = userMinPremiumFloor({ notional: n, minBpsPerDay: plan.min_premium_bps_per_day, secsToExpiry: secs, feeBps: plan.fee_bps });
      return {
        ...c,
        strike_usd: usdPrice(c.strike),
        expiry_utc: new Date(c.expiry * 1000).toISOString(),
        days_to_expiry: Math.round((secs / 86_400) * 100) / 100,
        strike_vs_spot_pct: grid.spot ? pctChange(BigInt(grid.spot), BigInt(c.strike)) : null,
        notional: n.toString(),
        fair_premium_usd: usd(c.fair_premium),
        premium_start_usd: usd(c.premium_start),
        premium_floor_usd: usd(c.premium_floor),
        user_min_floor: userMin.toString(),
        user_min_floor_usd: usd(userMin),
        floor_over_user_min: ratio(BigInt(c.premium_floor), userMin),
        in_distance_band: band ? secs / 86_400 >= band.min_days - 0.5 && secs / 86_400 <= band.max_days + 0.5 : null,
      };
    });
    return {
      ...grid,
      spot_usd: grid.spot ? usdPrice(grid.spot) : null,
      distance: dist === null ? null : { user_price: userPrice, user_price_vs_spot_pct: dist, band },
      cells,
    };
  }
}
