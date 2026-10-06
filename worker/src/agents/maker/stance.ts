/**
 * Maker stance: one GLM call per (maker, asset, epoch, round kind), decided before the auction window. The LLM never
 * emits base units — only {stance, spread_pct, thesis, confidence}. Code derives each round's bid from the stance and
 * that round's fair, and clamps it. Any failure (timeout, invalid JSON, ungrounded thesis, quota) → deterministic fallback.
 */
import { z } from "zod";
import type { ChatTransport } from "../../desk/llm/chat.js";
import { canonicalJson, sha256Bytes } from "../../desk/canonical.js";
import { checkThesis } from "../grounding.js";
import { completeJson, withTimeout } from "../json.js";
import { stanceSystemPrompt, type Persona } from "./personas.js";

export const stanceSchema = z.object({
  stance: z.enum(["bid", "pass"]),
  spread_pct: z.number().finite().min(0).max(20),
  thesis: z.string().trim().min(1).max(280),
  confidence: z.number().finite().min(0).max(1),
}).strict();
export type StanceOutput = z.infer<typeof stanceSchema>;

/** Inputs a maker sees. Public market data + the epoch + its own book. Never desk memos, proposals or plan bounds. */
export interface StanceContext {
  maker: string;
  asset: string;
  round_kind: "put" | "call";
  epoch: { expiry: number; expiry_utc: string; kind: "std" | "quick"; days_to_expiry: number };
  now_utc: string;
  spot: { price_usd: number; age_secs: number | null } | null;
  spot_moves: { move_1h_pct: number | null; move_24h_pct: number | null; move_7d_pct: number | null } | null;
  /** Reference cells for 1 whole asset at strikes near spot (the round's own strike/size are not known yet). */
  price_grid: { strike_usd: number; strike_vs_spot_pct: number | null; fair_usd: number | null; bid_usd: number | null; fair_iv: number | null; fill_probability: number | null; venues: number | null; error?: string }[];
  venue_dispersion: { venues_used: number; iv_spread_vol_pts: number | null } | null;
  events: { name: string; kind: string; at_utc: string; inside_option_life: boolean }[];
  my_inventory: { usdc: number; asset: number; open_notional_usdc: number; max_open_notional_usdc: number } | null;
  my_history: { rounds_won: number; settled: number; cumulative_pnl_usd: number; last: { my_bid_usd: number | null; pnl_usd: number | null; source: string }[] };
}

/** Keys that must never reach a maker (independence from the seller side). Enforced in tests and at runtime. */
export const FORBIDDEN_CONTEXT_KEYS = ["memo", "rationale", "proposal", "strike_min", "strike_max", "min_premium_bps_per_day", "max_expiry_secs", "horizon_end", "user_min_floor", "target_strike", "exit_strike", "verdict", "clef"];

export function assertIndependent(ctx: unknown): void {
  const json = JSON.stringify(ctx);
  for (const k of FORBIDDEN_CONTEXT_KEYS) if (json.includes(`"${k}"`)) throw new Error(`maker context leaks seller-side field "${k}"`);
}

export type StanceDecision =
  | { source: "llm"; stance: "bid" | "pass"; spread_pct: number; thesis: string; confidence: number; grounded: true; model: string; latency_ms: number; fallback_reason: null }
  | { source: "fallback"; stance: null; spread_pct: null; thesis: string | null; confidence: number | null; grounded: boolean | null; model: string | null; latency_ms: number | null; fallback_reason: string };

export async function decideStance(o: { transport: ChatTransport; model: string; persona: Persona; ctx: StanceContext; timeoutMs: number; now?: () => number }): Promise<StanceDecision> {
  const now = o.now ?? Date.now;
  const t0 = now();
  try { assertIndependent(o.ctx); } catch (e) { return fb(`independence check: ${(e as Error).message}`); }
  try {
    const r = await withTimeout(
      completeJson({ transport: o.transport, model: o.model, system: stanceSystemPrompt(o.persona), user: JSON.stringify(o.ctx), schema: stanceSchema, temperature: 0.4 }),
      o.timeoutMs, "maker stance",
    );
    const v = r.value;
    const g = checkThesis(v.thesis, o.ctx, o.ctx.events.map((e) => e.kind), [v.spread_pct, v.confidence]);
    if (!g.grounded) {
      const why = [g.unknownNumbers.length ? `numbers not in inputs: ${g.unknownNumbers.join(", ")}` : "", g.unknownEvents.length ? `events not in calendar: ${g.unknownEvents.join(", ")}` : ""].filter(Boolean).join("; ");
      return { source: "fallback", stance: null, spread_pct: null, thesis: v.thesis, confidence: v.confidence, grounded: false, model: r.model, latency_ms: now() - t0, fallback_reason: `ungrounded thesis (${why})` };
    }
    return { source: "llm", stance: v.stance, spread_pct: v.spread_pct, thesis: v.thesis, confidence: v.confidence, grounded: true, model: r.model, latency_ms: now() - t0, fallback_reason: null };
  } catch (e) {
    return { ...fb((e as Error).message.slice(0, 300)), latency_ms: now() - t0 };
  }
  function fb(reason: string): StanceDecision {
    return { source: "fallback", stance: null, spread_pct: null, thesis: null, confidence: null, grounded: null, model: null, latency_ms: null, fallback_reason: reason };
  }
}

export type BidFromStance = { bid: bigint; note: string | null } | { bid: null; note: string };

/**
 * bid = fair × (1 − spread_pct/100), clamped to [floor, min(start, fair)]. Pass → no bid. If fair < floor the range is
 * empty (the maker would pay above fair) → no bid.
 */
export function bidFromStance(stance: "bid" | "pass", spreadPct: number, fair: bigint, floor: bigint, start: bigint): BidFromStance {
  if (stance === "pass") return { bid: null, note: "stance: pass" };
  if (fair < floor) return { bid: null, note: "fair below the auction floor" };
  const bps = BigInt(Math.round(Math.min(Math.max(spreadPct, 0), 20) * 100)); // 0.01 % resolution
  const raw = (fair * (10_000n - bps)) / 10_000n;
  const hi = start < fair ? start : fair;
  if (raw < floor) return { bid: floor, note: "raised to the auction floor" };
  if (raw > hi) return { bid: hi, note: hi === start ? "capped at the auction start" : "capped at fair" };
  return { bid: raw, note: null };
}

export function hashRecord(rec: Record<string, unknown>): string {
  return Buffer.from(sha256Bytes(canonicalJson(rec))).toString("hex");
}
