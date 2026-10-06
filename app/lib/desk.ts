// Plain-English rendering of desk runs (worker/src/desk/types.ts shapes). Display only.

import type { DeskRunRow, DeskStep } from "./types";

const TOOL_LABELS: Record<string, string> = {
  get_plan: "Read the plan's limits",
  get_spot: "Checked the live price (Pyth)",
  price_grid: "Priced it against Deribit, OKX, Bybit and Binance quotes",
  fill_probability: "Estimated the chance it fills",
  lend_apy: "Checked the Jupiter Lend rate",
  venue_dispersion: "Compared prices across exchanges",
  spot_moves: "Looked at recent price moves",
  event_calendar: "Checked the economic calendar",
};

export function stepLabel(s: DeskStep): string {
  const d = s.detail ?? {};
  switch (s.step) {
    case "start":
      return "Desk started";
    case "quant_start":
      return "Quant (GLM) is looking at the market";
    case "tool_call": {
      const name = String(d.name ?? d.tool ?? "");
      return TOOL_LABELS[name] ?? `Ran ${name || "a tool"}`;
    }
    case "quant_proposal":
      return "Quant proposed a round";
    case "quant_repair":
      return "Quant fixed its answer format";
    case "risk_start":
      return "Risk (Clef) is reviewing";
    case "risk_result": {
      const r = riskSummary(d.answers as RiskAnswersLike | undefined);
      return r ? `Risk: ${r}` : "Risk reviewed it";
    }
    case "risk_fallback":
      return "Risk switched to its backup model";
    case "quant_retry":
      return "Quant adjusted after Risk's feedback";
    case "final":
      return "Decision made";
    case "memo":
      return "Decision memo hashed";
    case "error":
      return `Desk error: ${String(d.message ?? d.error ?? "unknown")}`;
    default:
      return s.step.replace(/_/g, " ");
  }
}

type Dist = Record<string, number>;
export interface RiskAnswersLike {
  verdict?: Dist;
  event_risk?: Dist;
  data_quality?: Dist;
  user_fit?: Dist;
  explanation_ok?: Dist;
}

const argmax = (d?: Dist): [string, number] | null => {
  if (!d) return null;
  let best: [string, number] | null = null;
  for (const [k, v] of Object.entries(d)) if (typeof v === "number" && (!best || v > best[1])) best = [k, v];
  return best;
};

export function riskSummary(a?: RiskAnswersLike | null): string | null {
  if (!a) return null;
  const v = argmax(a.verdict);
  const e = argmax(a.event_risk);
  if (!v) return null;
  const parts = [`${Math.round(v[1] * 100)}% ${v[0]}`];
  if (e) parts.push(`event risk ${e[0]}`);
  return parts.join(", ");
}

/** Pull the most recent Risk answers out of a run (memo.clef_answers or verdict column). */
export function runRiskAnswers(run: Pick<DeskRunRow, "memo" | "verdict">): RiskAnswersLike | null {
  const clef = (run.memo as { clef_answers?: { answers: RiskAnswersLike }[] } | null)?.clef_answers;
  if (clef?.length) return clef[clef.length - 1].answers;
  const v = run.verdict as { answers?: RiskAnswersLike } | RiskAnswersLike | null;
  if (!v) return null;
  return "answers" in v && v.answers ? v.answers : (v as RiskAnswersLike);
}

export interface ToolTraceLike {
  name: string;
  args?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
  duration_ms?: number;
}

export function runToolTraces(memo: Record<string, unknown> | null): ToolTraceLike[] {
  const t = (memo as { tool_traces?: ToolTraceLike[] } | null)?.tool_traces;
  return Array.isArray(t) ? t : [];
}

/** Fill probability from the desk's own tool trace (code-computed, not model text). */
export function fillProbability(memo: Record<string, unknown> | null): number | null {
  const t = runToolTraces(memo).filter((x) => x.name === "fill_probability" && x.ok !== false);
  const last = t[t.length - 1]?.result as { probability?: number } | undefined;
  return typeof last?.probability === "number" ? last.probability : null;
}

export function lendApyBps(memo: Record<string, unknown> | null): number | null {
  return lendApy(memo)?.bps ?? null;
}

/** Lend APY from the desk's lend_apy trace: devnet on-chain rate if known, else Jupiter's mainnet reference. */
export function lendApy(memo: Record<string, unknown> | null): { bps: number; source: "devnet" | "mainnet reference" } | null {
  const t = runToolTraces(memo).filter((x) => x.name === "lend_apy" && x.ok !== false);
  const r = t[t.length - 1]?.result as { devnet_apy_bps?: number | null; mainnet_reference_apy_bps?: number | null } | undefined;
  if (typeof r?.devnet_apy_bps === "number") return { bps: r.devnet_apy_bps, source: "devnet" };
  if (typeof r?.mainnet_reference_apy_bps === "number") return { bps: r.mainnet_reference_apy_bps, source: "mainnet reference" };
  return null;
}

export const ERROR_EXPLAIN: Record<string, string> = {
  StrikeOutOfBounds: "The price was outside the user's limits",
  StrikeOffTick: "The price wasn't on the allowed price grid",
  PremiumBelowUserMin: "The pay was below the user's minimum",
  ExpiryOutOfBounds: "The round would end after the user's deadline",
  SizeTooLarge: "The size was bigger than what's left of the plan",
  RateLimited: "Too many rounds today for this plan",
  OutsideAuctionWindow: "Outside the auction window",
  AuctionParamsInvalid: "The auction prices were inconsistent",
  EpochKindMismatch: "Wrong round type for this plan",
  ActiveRoundExists: "The plan already has a live round",
};

export function explainError(code: string | null | undefined): string | null {
  if (!code) return null;
  for (const [k, v] of Object.entries(ERROR_EXPLAIN)) if (code.includes(k)) return v;
  return null;
}

/** Repeated calls to the same tool, phrased per tool ("Compared prices across exchanges (2 expiries)"). */
const REPEAT_NOUN: Record<string, string> = {
  venue_dispersion: "expiries",
  price_grid: "expiries",
  fill_probability: "prices",
  spot_moves: "windows",
};

export interface StepRow {
  key: string;
  label: string;
}

/**
 * Display list for a live desk run: drops "start" and folds repeat tool calls into the first one, so
 * "Read the plan's limits" shows once and "Compared prices across exchanges" becomes "(2 expiries)".
 * Display only — the worker's step stream (and /desk's audit view) stay raw.
 */
export function collapseSteps(steps: DeskStep[]): StepRow[] {
  const rows: (StepRow & { tool?: string; count: number })[] = [];
  const byTool = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.step === "start") return;
    if (s.step === "tool_call") {
      const name = String(s.detail?.name ?? s.detail?.tool ?? "");
      const at = byTool.get(name);
      if (at !== undefined) {
        rows[at].count += 1;
        return;
      }
      byTool.set(name, rows.length);
      rows.push({ key: `tool-${name}-${i}`, label: stepLabel(s), tool: name, count: 1 });
      return;
    }
    const label = stepLabel(s);
    if (rows.length && rows[rows.length - 1].label === label) return;
    rows.push({ key: `${s.step}-${i}`, label, count: 1 });
  });
  return rows.map(({ key, label, tool, count }) => {
    const noun = tool ? REPEAT_NOUN[tool] : undefined;
    return { key, label: count > 1 && noun ? `${label} (${count} ${noun})` : label };
  });
}
