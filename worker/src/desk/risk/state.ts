/**
 * Risk state builder. Risk sees the proposal, market data and the user's stated patience —
 * NOT the plan bounds (strike range, max expiry, deadline, minimum yield, rate limits, remaining
 * size). Bounds are the program's job (BUILD §5). Built from a whitelist, never by copying get_plan.
 */
import type { Patience, QuantProposal, ToolTrace } from "../types.js";
import { eventsBetween } from "../events.js";
import { formatUnits, notional, pctChange, usd, usdPrice } from "../units.js";

export interface RiskStateInput {
  proposal: QuantProposal;
  traces: ToolTrace[];
  asset: string;
  asset_decimals: number;
  round_kind: "put" | "call";
  patience: Patience | null;
  now_ms: number;
}

function lastOk(traces: ToolTrace[], name: string, pred?: (args: any, result: any) => boolean): any | null {
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i]!;
    if (t.name === name && t.ok && (!pred || pred(t.args, t.result))) return t.result;
  }
  return null;
}

/** Fields of a price cell Risk may see (drops the user-minimum helpers). */
const CELL_FIELDS = ["strike", "expiry", "fair_premium", "bid_premium", "premium_start", "premium_floor", "fair_iv", "bid_iv", "venues", "quick_pricing", "error"];

export function buildRiskState(i: RiskStateInput): Record<string, unknown> {
  const p = i.proposal;
  const now = Math.floor(i.now_ms / 1000);
  const spot = lastOk(i.traces, "get_spot");
  const spotPrice: string | null = spot?.price ?? lastOk(i.traces, "price_grid")?.spot ?? null;

  let cell: Record<string, unknown> | null = null;
  for (let k = i.traces.length - 1; k >= 0 && !cell; k--) {
    const t = i.traces[k]!;
    if (t.name !== "price_grid" || !t.ok) continue;
    const g = t.result as any;
    if (g?.size !== p.size) continue;
    const c = (g.cells ?? []).find((c: any) => c.strike === p.strike && c.expiry === p.expiry);
    if (c) cell = Object.fromEntries(CELL_FIELDS.filter((f) => f in c).map((f) => [f, c[f]]));
  }

  const fill = lastOk(i.traces, "fill_probability", (a) => String(a?.strike) === p.strike && Number(a?.expiry) === p.expiry);
  const disp = lastOk(i.traces, "venue_dispersion", (a) => Number(a?.expiry) === p.expiry) ?? lastOk(i.traces, "venue_dispersion");
  const moves = lastOk(i.traces, "spot_moves");
  const apy = lastOk(i.traces, "lend_apy");

  const expiry = p.expiry ?? now;
  const n = p.strike && p.size ? notional(p.strike, p.size, i.asset_decimals) : null;

  return {
    now_utc: new Date(i.now_ms).toISOString(),
    asset: i.asset,
    round_type: i.round_kind === "put" ? "cash-secured put (user may buy the asset at the strike)" : "covered call (user may sell the asset at the strike)",
    user_stated_patience: i.patience ?? "not stated",
    proposal: {
      action: p.action,
      strike: p.strike,
      strike_usd: p.strike ? usdPrice(p.strike) : null,
      size: p.size,
      size_human: p.size ? `${formatUnits(p.size, i.asset_decimals)} ${i.asset}` : null,
      notional_usd: n !== null ? usd(n) : null,
      expiry: p.expiry,
      expiry_utc: p.expiry ? new Date(p.expiry * 1000).toISOString() : null,
      days_to_expiry: p.expiry ? Math.round(((p.expiry - now) / 86_400) * 100) / 100 : null,
      auction_secs: p.auction_secs,
      premium_start_usd: p.premium_start ? usd(p.premium_start) : null,
      premium_floor_usd: p.premium_floor ? usd(p.premium_floor) : null,
      strike_vs_spot_pct: p.strike && spotPrice ? pctChange(BigInt(spotPrice), BigInt(p.strike)) : null,
      rationale: scrubRationale(p.rationale, i.traces, p),
    },
    market: {
      spot_usd: spotPrice ? usdPrice(spotPrice) : null,
      spot_age_secs: spot?.publish_time ? now - spot.publish_time : null,
      spot_moves_pct: moves ? { h1: moves.move_1h_pct, h24: moves.move_24h_pct, d7: moves.move_7d_pct } : null,
      pricing_cell: cell,
      fill_probability: fill?.probability ?? null,
      venue_dispersion: disp ? { venues_used: disp.venues_used, iv_spread_vol_pts: disp.iv_spread_vol_pts, max_quote_age_secs: disp.max_quote_age_secs ?? null } : null,
      lend_apy_bps: apy ? { devnet: apy.devnet_apy_bps, mainnet_reference: apy.mainnet_reference_apy_bps } : null,
    },
    events_before_expiry: eventsBetween(now, expiry + 86_400).map((e) => ({ name: e.name, at_utc: e.at_utc, hours_before_expiry: Math.round((expiry - e.at_unix) / 360) / 10 })),
    quant_tool_errors: i.traces.filter((t) => !t.ok).map((t) => ({ tool: t.name, error: t.error })),
  };
}

/** BOUND_WORDS, global (in-place redaction). */
const boundWordsG = () => new RegExp(BOUND_WORDS.source, "gi");
/** Plan-bound keys in get_plan output (strike range, target, minimum yield, deadline, limits, remaining size). */
const BOUND_KEY = /(min|max|target|deadline|horizon|limit|bound|range|remaining|goal|user_price|lock|exit)/i;
/** User-minimum phrases redacted in place (with the number that follows them, if any). */
const USER_LIMIT_INLINE = /\b(?:(?:vs\.? |against |versus )?(?:an? |the )?user'?s?[ _-]?(?:\$?\d[\d,.]*(?:[ -]?(?:unit|base[ -]unit|bps)s?)? )?min(?:imum)?\w*(?: (?:acceptable )?(?:floor|yield|premium|pay))?(?: of)?(?: [=:]?\s?\$?\d[\d,.]*x?(?: (?:USDC )?(?:base units|units|bps(?:\/day)?))?)?|\w*over_user_min\w*(?:\s?[=:]?\s?\d[\d,.]*x?)?)/gi;
/** Words that only make sense when the sentence talks about the user's limits. */
const BOUND_WORDS = /\b(target(ed)? (price|strike)|strike (range|band|bounds?|min|max)|min(imum)?[ _-]?(yield|premium|pay|bps)|max(imum)?[ _-]?(expiry|rounds?)|deadline|horizon|user'?s? (min|max|limit|bound|target|price)|plan (bounds?|limits?)|within (the )?(bounds?|limits?|range)|(upper|lower) bound|rate limit)\b/i;

function boundTokens(traces: ToolTrace[], keep: Set<string>): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const str = String(v).trim();
    if (!str || str.length > 40) return;
    for (const m of str.match(/\d[\d,]*(\.\d+)?/g) ?? []) {
      const n = m.replace(/,/g, "");
      if (n.replace(/\D/g, "").length < 2) continue; // single digits are too common to redact on
      const variants = [n, String(Number(n)), Number(n).toFixed(2)];
      for (const x of variants) if (!keep.has(x)) out.add(x);
    }
  };
  const walk = (o: unknown, boundCtx: boolean, depth: number) => {
    if (depth > 4 || o === null || o === undefined) return;
    if (typeof o !== "object") { if (boundCtx) add(o); return; }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) walk(v, boundCtx || BOUND_KEY.test(k), depth + 1);
  };
  for (const t of traces) if (t.name === "get_plan" && t.ok) walk(t.result, false, 0);
  return out;
}

/**
 * The Quant's free text sometimes repeats the plan bounds it read from get_plan (strike range, minimum yield,
 * deadline). Risk must judge without them, so drop every sentence that names a bound or quotes a bound value.
 * Values the proposal itself carries (strike, expiry, premiums) are not bounds and stay.
 */
export function scrubRationale(rationale: string | null | undefined, traces: ToolTrace[], p?: Partial<QuantProposal>): string | null {
  if (!rationale) return rationale ?? null;
  const keep = new Set<string>();
  for (const v of [p?.strike, p?.size, p?.expiry, p?.premium_start, p?.premium_floor, p?.auction_secs]) {
    if (v === null || v === undefined) continue;
    keep.add(String(v));
    if (p?.strike && v === p.strike) { const usdN = Number(v) / 1e6; keep.add(String(usdN)); keep.add(usdN.toFixed(2)); }
  }
  const tokens = boundTokens(traces, keep);
  // Inline-redact the user's-minimum phrasings first (live 6 Oct: "clearing the user's minimum", "vs user_min_floor 90
  // (floor_over_user_min 13.6x)", "the user's 53-unit minimum"). Redacting in place instead of dropping the sentence keeps
  // the premium numbers Risk checks: rationales withheld whole were vetoed "explanation_ok: no" ~2/3 of the time.
  const inlined = rationale.replace(USER_LIMIT_INLINE, "[redacted]");
  const sentences = inlined.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sen) => {
    if (BOUND_WORDS.test(sen)) return false;
    const nums = (sen.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((m) => m.replace(/,/g, ""));
    return !nums.some((n) => tokens.has(n) || tokens.has(String(Number(n))) || tokens.has(Number(n).toFixed(2)));
  });
  if (kept.length === sentences.length) return inlined === rationale ? rationale : `${inlined} [plan-bound references removed]`;
  if (kept.length) return `${kept.join(" ")} [plan-bound references removed]`;
  // Every sentence touched a bound. Withholding the whole text made Risk's explanation_ok unanswerable: live 6 Oct, 13 of
  // 16 withheld rationales were vetoed "rationale does not match the tool numbers" (vs 1 of 23 partly scrubbed ones).
  // Redact the bound words and values in place instead, so the market numbers Risk checks survive.
  const isBound = (m: string) => { const n = m.replace(/,/g, ""); return tokens.has(n) || tokens.has(String(Number(n))) || tokens.has(Number(n).toFixed(2)); };
  const redacted = inlined.replace(boundWordsG(), "[redacted]").replace(/\d[\d,]*(\.\d+)?/g, (m) => (isBound(m) ? "[redacted]" : m));
  return `${redacted} [plan-bound references redacted]`;
}
