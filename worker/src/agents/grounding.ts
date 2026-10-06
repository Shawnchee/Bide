/**
 * Thesis grounding (same idea as the desk's `provenance`): every number a maker writes in its thesis must appear in
 * the tool outputs it was given, and any macro event it names must be in the curated calendar (events.json) inside
 * its context. Otherwise the thesis is `ungrounded` and the maker falls back to the deterministic bid.
 */

const NUM_RE = /\d+(?:[.,]\d+)?/g;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

const stripZeros = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

function addVariants(out: Set<string>, n: number) {
  if (!Number.isFinite(n)) return;
  for (const v of [n, Math.abs(n)]) {
    out.add(String(v));
    for (let d = 0; d <= 3; d++) out.add(stripZeros(v.toFixed(d)));
    if (Math.abs(v) <= 1) for (let d = 0; d <= 2; d++) out.add(stripZeros((v * 100).toFixed(d))); // 0.31 → "31" (%)
  }
}

/**
 * Numbers in `ctx`. `values`: numeric values and numbers inside non-date strings (with rounding / percent variants).
 * `all`: also digits from ISO dates and key names (e.g. "14" from a CPI date, "7" from move_7d_pct) — fine for dates
 * and labels, but a price or percentage in a thesis must match `values`.
 */
export function groundedSets(ctx: unknown, extra: number[] = []): { values: Set<string>; all: Set<string> } {
  const values = new Set<string>(), all = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (key) for (const m of key.matchAll(NUM_RE)) all.add(m[0]);
    if (typeof v === "number") addVariants(values, v);
    else if (typeof v === "bigint") addVariants(values, Number(v));
    else if (typeof v === "string") {
      const target = ISO_RE.test(v) ? all : values;
      for (const m of v.matchAll(NUM_RE)) { addVariants(target, Number(m[0].replace(",", "."))); all.add(m[0]); }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(ctx);
  for (const n of extra) addVariants(values, n);
  for (const x of values) all.add(x);
  return { values, all };
}

/** Back-compat: every grounded number (values ∪ dates ∪ labels). */
export function groundedNumbers(ctx: unknown, extra: number[] = []): Set<string> {
  return groundedSets(ctx, extra).all;
}

/** Numbers written in a thesis ("$0.52", "1.8%", "3 venues", "1,234.5"). Thousands separators are removed first. */
export function thesisNumbers(thesis: string): string[] {
  return thesisTokens(thesis).map((t) => t.n);
}

/** Thesis numbers; `quantity` = written as money or a percentage ($x, x%, x vol, x bps) — those must be real values. */
export function thesisTokens(thesis: string): { n: string; quantity: boolean }[] {
  const t = thesis.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  return [...t.matchAll(/(\$\s?)?(\d+(?:\.\d+)?)(\s?(%|vol|bps|pts))?/gi)].map((m) => ({ n: stripZeros(m[2]!), quantity: Boolean(m[1] || m[3]) }));
}

/** Event words the personas might use → the calendar kinds that justify them. */
const EVENT_WORDS: [RegExp, string[]][] = [
  [/\bFOMC\b|\bFed\b|rate decision|\bpowell\b/i, ["fomc"]],
  [/\bCPI\b|inflation (print|report|data)/i, ["cpi"]],
  [/\bNFP\b|payrolls?|jobs report|employment report/i, ["nfp"]],
  [/\bPCE\b|\bGDP\b|\bECB\b|\bBOJ\b|earnings|halving|\bETF\b|unlock/i, ["__never__"]], // not in our calendar → never citable
];

export interface GroundingResult { grounded: boolean; unknownNumbers: string[]; unknownEvents: string[] }

export function checkThesis(thesis: string, ctx: unknown, eventKindsInContext: string[], extra: number[] = []): GroundingResult {
  const { values, all } = groundedSets(ctx, extra);
  const unknownNumbers = thesisTokens(thesis).filter((t) => !(t.quantity ? values : all).has(t.n)).map((t) => t.n);
  const kinds = new Set(eventKindsInContext.map((k) => k.toLowerCase()));
  const unknownEvents: string[] = [];
  for (const [re, need] of EVENT_WORDS) {
    const m = thesis.match(re);
    if (m && !need.some((k) => kinds.has(k))) unknownEvents.push(m[0]);
  }
  return { grounded: unknownNumbers.length === 0 && unknownEvents.length === 0, unknownNumbers, unknownEvents };
}
