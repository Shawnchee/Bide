import type { RiskAnswers, RiskBinding, Verdict } from "../types.js";

/** Ties go to the more conservative verdict. */
const VERDICT_ORDER: Verdict[] = ["veto", "adjust", "approve"];

const CONCERNS: { q: keyof RiskAnswers; option: string; text: string }[] = [
  { q: "event_risk", option: "high", text: "A major scheduled macro event falls right before expiry; pick an expiry that avoids it or skip." },
  { q: "event_risk", option: "medium", text: "A major scheduled macro event falls inside the round; check the premium pays for it or move the expiry." },
  { q: "data_quality", option: "poor", text: "Pricing data looks unreliable (few venues, stale or dispersed quotes); re-check venue_dispersion or skip." },
  { q: "user_fit", option: "too_aggressive", text: "The round looks too aggressive for the user's stated patience; consider a smaller size or a different expiry." },
  { q: "user_fit", option: "too_passive", text: "The round looks too passive for the user's stated patience; consider a larger size or a nearer expiry." },
  { q: "explanation_ok", option: "no", text: "The rationale does not match the tool numbers; re-check the numbers and restate the rationale from them." },
];

/** Binding rule (BUILD §5): argmax verdict; adjust → one Quant retry with the top concern. */
export function bindRisk(a: RiskAnswers): RiskBinding {
  let verdict: Verdict = "veto";
  let best = -1;
  for (const v of VERDICT_ORDER) {
    if (a.verdict[v] > best) {
      best = a.verdict[v];
      verdict = v;
    }
  }
  let top: RiskBinding["top_concern"] = null;
  for (const c of CONCERNS) {
    const p = (a[c.q] as Record<string, number>)[c.option] ?? 0;
    if (!top || p > top.probability) top = { question: c.q, option: c.option, probability: p, text: c.text };
  }
  return { verdict, top_concern: top };
}

/** Normalise a probability map over `keys` (missing → 0; all-zero → uniform). Throws on NaN/negative. */
export function normalise<K extends string>(keys: readonly K[], raw: Record<string, unknown>): Record<K, number> {
  const out = {} as Record<K, number>;
  let sum = 0;
  for (const k of keys) {
    const v = raw[k] === undefined ? 0 : Number(raw[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`probability for "${k}" is not a non-negative number`);
    out[k] = v;
    sum += v;
  }
  for (const k of keys) out[k] = sum > 0 ? out[k] / sum : 1 / keys.length;
  return out;
}

export function summariseRisk(a: RiskAnswers): string {
  const b = bindRisk(a);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const ev = (Object.entries(a.event_risk) as [string, number][]).sort((x, y) => y[1] - x[1])[0]!;
  return `Risk: ${pct(a.verdict[b.verdict])} ${b.verdict}, event risk ${ev[0]}`;
}
