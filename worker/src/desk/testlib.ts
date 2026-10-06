/**
 * TEST DOUBLES — for *.test.ts only. Never import this from product code.
 * A scripted chat transport and a fixed-data DeskTools so the orchestrator can be tested
 * without network or keys. Numbers are illustrative fixtures, not market data.
 */
import type { ChatRequest, ChatResponse, ChatTransport, ToolCall } from "./llm/chat.js";
import type { DeskTools, PlanView, PriceCell } from "./types.js";

export const NOW_MS = Date.parse("2026-10-05T15:00:00Z");
export const EXP = { d1: 1791273600, w1: 1791532800, w2: 1792137600, w3: 1792742400, m1: 1793347200 };

export function fixturePlan(over: Partial<PlanView> = {}): PlanView {
  return {
    plan_id: "PLAN111",
    owner: "OWNER111",
    asset: "SOL",
    asset_mint: "So11111111111111111111111111111111111111112",
    asset_decimals: 9,
    side: "buy",
    phase: "accumulate",
    quick: false,
    target_strike: "110000000",
    exit_strike: "0",
    lock_strike: true,
    strike_min: "110000000",
    strike_max: "110000000",
    call_strike_min: "0",
    call_strike_max: "0",
    strike_tick: "1000000",
    size_total: "4500000000",
    size_filled: "0",
    collateral_principal: "495000000",
    min_premium_bps_per_day: 10,
    max_expiry_secs: 30 * 86400,
    horizon_end: EXP.m1 + 86400,
    max_rounds_per_day: 6,
    rounds_today: 0,
    paused: false,
    status: "active",
    active_round: null,
    pending_settlement: null,
    fee_bps: 1000,
    open_epochs: [
      { expiry: EXP.d1, kind: "std" },
      { expiry: EXP.w1, kind: "std" },
      { expiry: EXP.w2, kind: "std" },
      { expiry: EXP.w3, kind: "std" },
      { expiry: EXP.m1, kind: "std" },
    ],
    ...over,
  };
}

export function fakeTools(plan: PlanView = fixturePlan(), calls: string[] = []): DeskTools {
  return {
    async get_plan(a) {
      calls.push("get_plan");
      return { ...plan, plan_id: a.plan_id };
    },
    async get_spot() {
      calls.push("get_spot");
      return { asset: "SOL", price: "121000000", conf: "50000", publish_time: NOW_MS / 1000 - 120, source: "pyth-push-feed" };
    },
    async price_grid(a) {
      calls.push("price_grid");
      const cells: PriceCell[] = [];
      for (const strike of a.strikes)
        for (const expiry of a.expiries) {
          const days = (expiry - NOW_MS / 1000) / 86400;
          const fair = BigInt(Math.round(days * 400_000)) * BigInt(a.size) / 1_000_000_000n; // fixture only
          cells.push({ strike, expiry, fair_premium: fair.toString(), bid_premium: ((fair * 9n) / 10n).toString(), premium_start: ((fair * 13n) / 10n).toString(), premium_floor: ((fair * 81n) / 100n).toString(), fair_iv: 0.62, bid_iv: 0.58, venues: [{ venue: "deribit", mid_iv: 0.62 }, { venue: "okx", mid_iv: 0.61 }] });
        }
      return { asset: a.asset, kind: a.kind, size: a.size, spot: "121000000", cells };
    },
    async fill_probability(a) {
      calls.push("fill_probability");
      return { asset: a.asset, strike: a.strike, expiry: a.expiry, kind: a.kind, probability: 0.31, iv: 0.62 };
    },
    async lend_apy(a) {
      calls.push("lend_apy");
      return { mint: a.mint, devnet_apy_bps: 520, mainnet_reference_apy_bps: 610 };
    },
    async venue_dispersion(a) {
      calls.push("venue_dispersion");
      return { asset: a.asset, expiry: a.expiry, venues_used: 3, iv_spread_vol_pts: 1.8, max_quote_age_secs: 6 };
    },
    async spot_moves(a) {
      calls.push("spot_moves");
      return { asset: a.asset, move_1h_pct: 0.2, move_24h_pct: -1.4, move_7d_pct: 3.1 };
    },
  };
}

type Step = ((req: ChatRequest) => Partial<ChatResponse>) | Partial<ChatResponse>;

/** Scripted transport: returns the queued responses in order; records every request. */
export function scriptedTransport(script: Step[]): ChatTransport & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    provider: "test-double",
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const s = script[i++];
      if (!s) throw new Error(`scriptedTransport: no response queued for request #${i}`);
      const r = typeof s === "function" ? s(req) : s;
      return { model: "glm-5.3", content: null, tool_calls: [], reasoning_content: null, finish_reason: "stop", ...r };
    },
  };
}

let n = 0;
export function toolCalls(...calls: [string, unknown][]): Partial<ChatResponse> {
  const tc: ToolCall[] = calls.map(([name, args]) => ({ id: `call_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
  return { tool_calls: tc, content: null, finish_reason: "tool_calls" };
}

export const reply = (obj: unknown): Partial<ChatResponse> => ({ content: typeof obj === "string" ? obj : JSON.stringify(obj) });

export function riskReply(verdict: { approve: number; adjust: number; veto: number }, over: Record<string, unknown> = {}): Partial<ChatResponse> {
  return reply({
    verdict,
    event_risk: { none: 0.6, low: 0.3, medium: 0.08, high: 0.02 },
    data_quality: { poor: 0.05, fair: 0.25, good: 0.7 },
    user_fit: { matches: 0.8, too_aggressive: 0.15, too_passive: 0.05 },
    explanation_ok: { yes: 0.9, no: 0.1 },
    ...over,
  });
}
