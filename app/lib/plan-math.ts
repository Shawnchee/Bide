// Pure plan math for the /earn form, the confirmation card and the payoff slider.
// Units follow BUILD §3.1: strike = USDC base units per 1 whole asset; size = asset base units.

import type { AssetInfo } from "./constants";
import type { Patience, PlanSide } from "./types";

export type Goal = "buy" | "sell" | "both";

export const goalToSide = (g: Goal): PlanSide => (g === "both" ? "wheel" : g);

const pow10 = (n: number) => 10n ** BigInt(n);

/** Dollars → USDC base units, snapped DOWN to the strike tick (puts: lower is safer for the user). */
export function dollarsToStrike(dollars: number, tick: bigint): bigint {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0n;
  const base = BigInt(Math.round(dollars * 1e6));
  return (base / tick) * tick;
}

export function strikeToDollars(strike: bigint): number {
  return Number(strike) / 1e6;
}

/** Notional (USDC base units) = strike × size / 10^dec, rounded up (amount the user must lock). */
export function notionalUp(strike: bigint, size: bigint, decimals: number): bigint {
  const num = strike * size;
  const d = pow10(decimals);
  return (num + d - 1n) / d;
}

export function notionalDown(strike: bigint, size: bigint, decimals: number): bigint {
  return (strike * size) / pow10(decimals);
}

/** Buy side: how many asset base units a USDC budget buys at `strike` (floored). */
export function sizeFromUsdc(usdcBase: bigint, strike: bigint, decimals: number): bigint {
  if (strike <= 0n) return 0n;
  return (usdcBase * pow10(decimals)) / strike;
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  // Avoid float drift: go through a fixed string.
  const [w, f = ""] = amount.toFixed(decimals).split(".");
  return BigInt(w) * pow10(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

// --- Target presets -------------------------------------------------------------------------

/** Distance from spot per preset. Std plans: matches the desk's distance bands (BUILD §5). */
export const PRESET_DISTANCE: Record<Patience, number> = { patient: 0.12, balanced: 0.06, eager: 0.02 };
/** Quick plans settle in 10 min, so "near" is much nearer (BUILD §9: spot − 0.3–0.5%). */
export const QUICK_PRESET_DISTANCE: Record<Patience, number> = { patient: 0.01, balanced: 0.005, eager: 0.003 };

/** Tick (USDC base units) → dollars. */
export const tickDollars = (tick: bigint) => Number(tick) / 1e6;

/** Snap a dollar price to the tick grid: buy side rounds down, sell side up. Exact in tick units. */
export function snapDollars(dollars: number, tick: bigint, up: boolean): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  const t = Number(tick);
  const base = Math.round(dollars * 1e6);
  const ticks = up ? Math.ceil(base / t - 1e-9) : Math.floor(base / t + 1e-9);
  return (ticks * t) / 1e6;
}

export function presetPrice(spot: number, patience: Patience, buySide: boolean, quick: boolean, tick: bigint = 1_000_000n): number {
  const d = (quick ? QUICK_PRESET_DISTANCE : PRESET_DISTANCE)[patience];
  const raw = buySide ? spot * (1 - d) : spot * (1 + d);
  return snapDollars(raw, tick, !buySide);
}

/** Nearest preset to a typed price (for highlighting). */
export function nearestPatience(spot: number, price: number, buySide: boolean, quick: boolean): Patience | null {
  const dist = buySide ? (spot - price) / spot : (price - spot) / spot;
  const table = quick ? QUICK_PRESET_DISTANCE : PRESET_DISTANCE;
  let best: Patience | null = null;
  let bestErr = Infinity;
  for (const p of Object.keys(table) as Patience[]) {
    const err = Math.abs(table[p] - dist);
    if (err < bestErr) {
      bestErr = err;
      best = p;
    }
  }
  return bestErr < 0.006 ? best : null;
}

// --- Deadline -------------------------------------------------------------------------------

export type HorizonChoice = "1w" | "1m" | "3m" | "date" | "q30m" | "q1h" | "q3h";
export const DAY = 86_400;
export const MAX_HORIZON_SECS = 180 * DAY;

export function horizonEnd(choice: HorizonChoice, now: number, customDate?: string): number | null {
  switch (choice) {
    case "1w":
      return now + 7 * DAY;
    case "1m":
      return now + 30 * DAY;
    case "3m":
      return now + 90 * DAY;
    case "q30m":
      return now + 30 * 60;
    case "q1h":
      return now + 60 * 60;
    case "q3h":
      return now + 3 * 60 * 60;
    case "date": {
      if (!customDate) return null;
      // End of the chosen day, 08:00 UTC (the epoch time) so the last daily check is included.
      const t = Date.parse(`${customDate}T08:00:00Z`);
      return Number.isFinite(t) ? Math.floor(t / 1000) : null;
    }
  }
}

export function validateHorizon(end: number | null, now: number, quick: boolean): string | null {
  if (end === null) return "Pick a date.";
  if (quick) return end >= now + 10 * 60 ? null : "Quick plans need at least 10 minutes.";
  if (end < now + DAY) return "Pick a date at least 1 day away.";
  if (end > now + MAX_HORIZON_SECS) return "Pick a date within 6 months.";
  return null;
}

// --- Minimum pay ----------------------------------------------------------------------------

/** min_premium_bps_per_day presets, explained as "$ per day per $1,000". */
export const MIN_PAY_PRESETS = [
  { id: "relaxed", bps: 5, label: "$0.50", hint: "per day per $1,000 — fills more rounds" },
  { id: "standard", bps: 10, label: "$1.00", hint: "per day per $1,000 — recommended" },
  { id: "choosy", bps: 20, label: "$2.00", hint: "per day per $1,000 — skips more rounds" },
] as const;
export type MinPayId = (typeof MIN_PAY_PRESETS)[number]["id"];

// --- create_plan args (BUILD §3.3 #4) -------------------------------------------------------

export interface CreatePlanArgs {
  nonce: bigint;
  side: PlanSide;
  quick: boolean;
  targetStrike: bigint;
  exitStrike: bigint;
  sizeTotal: bigint;
  lockStrike: boolean;
  band: bigint;
  exitBand: bigint;
  minPremiumBpsPerDay: number;
  maxExpirySecs: number;
  horizonEnd: number;
  maxRoundsPerDay: number;
}

export interface DraftInput {
  goal: Goal;
  asset: AssetInfo;
  quick: boolean;
  targetDollars: number;
  exitDollars: number | null;
  /** Buy/Both: USDC to commit. Sell: asset amount to commit. */
  amount: number;
  horizonEnd: number;
  minPayBps: number;
  now: number;
}

export interface Draft {
  args: CreatePlanArgs;
  /** What the user locks: USDC base units (buy/both) or asset base units (sell). */
  lockAmount: bigint;
  lockIsUsdc: boolean;
  notional: bigint;
  error: string | null;
}

export function buildDraft(d: DraftInput): Draft {
  const { asset } = d;
  const side = goalToSide(d.goal);
  const sellSide = d.goal === "sell";
  // Sell side: snap the call strike UP to the tick (higher is the user's side).
  const tick = asset.strikeTick;
  const snapUp = (dollars: number) => {
    const s = dollarsToStrike(dollars, 1n);
    return ((s + tick - 1n) / tick) * tick;
  };
  const target = sellSide ? snapUp(d.targetDollars) : dollarsToStrike(d.targetDollars, tick);
  const exit = d.goal === "both" && d.exitDollars ? snapUp(d.exitDollars) : sellSide ? target : 0n;

  let size = 0n;
  let lockAmount = 0n;
  if (sellSide) {
    size = toBaseUnits(d.amount, asset.decimals);
    lockAmount = size;
  } else {
    size = sizeFromUsdc(toBaseUnits(d.amount, 6), target, asset.decimals);
    lockAmount = notionalUp(target, size, asset.decimals);
  }
  const notional = notionalDown(target, size, asset.decimals);

  const secsLeft = d.horizonEnd - d.now;
  const maxExpirySecs = d.quick ? 20 * 60 : Math.max(DAY, Math.min(secsLeft, 35 * DAY));

  let error: string | null = null;
  if (target <= 0n) error = "Enter a price.";
  else if (d.goal === "both" && (!d.exitDollars || exit <= target)) error = "Your sell price must be above your buy price.";
  else if (size <= 0n) error = "Enter an amount.";

  return {
    args: {
      nonce: BigInt(d.now) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      side,
      quick: d.quick,
      targetStrike: target,
      exitStrike: exit,
      sizeTotal: size,
      lockStrike: true,
      band: 0n,
      exitBand: 0n,
      minPremiumBpsPerDay: d.minPayBps,
      maxExpirySecs,
      horizonEnd: d.horizonEnd,
      maxRoundsPerDay: d.quick ? 30 : 6,
    },
    lockAmount,
    lockIsUsdc: !sellSide,
    notional,
    error,
  };
}

// --- Payoff (pure code; never an LLM) -------------------------------------------------------

export interface PayoffInput {
  goal: Goal;
  strike: number; // dollars
  size: number; // whole asset units
  premiumNet: number | null; // dollars after fee
  lendYield: number | null; // dollars, estimate
  settle: number; // dollars
}

export interface PayoffResult {
  filled: boolean;
  /** Plain-English lines. */
  headline: string;
  detail: string;
  /** Value of what the user holds afterwards, in dollars at the settle price (incl. premium). */
  endValue: number;
  /** Same capital, no plan, valued at the settle price. */
  holdValue: number;
}

export function payoff(p: PayoffInput, symbol: string): PayoffResult {
  const extra = (p.premiumNet ?? 0) + (p.lendYield ?? 0);
  const notional = p.strike * p.size;
  if (p.goal === "sell") {
    const filled = p.settle > p.strike;
    const holdValue = p.size * p.settle;
    if (filled) {
      return {
        filled,
        headline: `You sell ${fmtSize(p.size)} ${symbol} at $${fmtPrice(p.strike)}`,
        detail: `You receive $${fmtPrice(notional)} USDC and keep everything you were paid.`,
        endValue: notional + extra,
        holdValue,
      };
    }
    return {
      filled,
      headline: `You keep your ${fmtSize(p.size)} ${symbol}`,
      detail: `Nothing is sold. You keep your ${symbol} and everything you were paid.`,
      endValue: holdValue + extra,
      holdValue,
    };
  }
  const filled = p.settle < p.strike;
  const holdValue = notional;
  if (filled) {
    return {
      filled,
      headline: `You buy ${fmtSize(p.size)} ${symbol} at $${fmtPrice(p.strike)}`,
      detail:
        p.settle < p.strike * 0.85
          ? `Even though ${symbol} is at $${fmtPrice(p.settle)}, you pay your price of $${fmtPrice(p.strike)}. You keep everything you were paid.`
          : `You pay $${fmtPrice(notional)} and keep everything you were paid.`,
      endValue: p.size * p.settle + extra,
      holdValue,
    };
  }
  return {
    filled,
    headline: `You keep your $${fmtPrice(notional)} USDC`,
    detail: `Nothing is bought. Your USDC stays put and you keep everything you were paid.`,
    endValue: notional + extra,
    holdValue,
  };
}

/** "$112", "$119.40", "$64,250" — cents shown only when the price has them. */
export function fmtPrice(n: number): string {
  const cents = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString("en-US", cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 });
}
export function fmtSize(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Fee: Config.fee_bps of every premium (BUILD §3.2). */
export const afterFee = (gross: number, feeBps: number) => gross * (1 - feeBps / 10_000);
