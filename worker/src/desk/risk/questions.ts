import type { RiskAnswers } from "../types.js";

/**
 * Risk questions in Cloudflare Clef's request format (developers.cloudflare.com/workers-ai/models/clef,
 * checked 2026-10-05): `questions` is an object keyed by id; each has `type` (choice | score | noul),
 * `instructions`, and `criteria` (choice: {option: description}; score: ordered labels, lowest first;
 * noul: none). The GLM fallback is asked the same questions.
 */
export type ClefQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

/** Score questions: our option keys in the same order as the Clef criteria labels (lowest first). */
export const SCORE_KEYS = {
  event_risk: ["none", "low", "medium", "high"],
  data_quality: ["poor", "fair", "good"],
} as const;

export const RISK_QUESTIONS: Record<keyof RiskAnswers, ClefQuestion> = {
  verdict: {
    type: "choice",
    instructions:
      "You are the risk reviewer for one proposed round on a plan that sells fully collateralised options for a user. Judge the proposal on risk only, using the numbers in the state. Should it go ahead?",
    criteria: {
      approve: "The round is sensible as proposed: premium is fair for the risk, data is reliable, no unpriced scheduled event inside the round, and it fits the user's stated patience.",
      adjust: "The idea is reasonable but one specific thing should change first (expiry, size, or timing around an event), or the rationale contradicts the numbers.",
      veto: "Do not open this round this cycle: data is unreliable, a major scheduled event makes it unsafe, or the risk is clearly not paid for.",
    },
  },
  event_risk: {
    type: "score",
    instructions: "How much scheduled macro-event risk (FOMC, CPI, jobs report from the event calendar in the state) falls between now and the round's expiry?",
    criteria: ["none: no scheduled event before expiry", "low: a minor event, or one far from expiry", "medium: a major event inside the round", "high: a major event right before expiry"],
  },
  data_quality: {
    type: "score",
    instructions: "How reliable is the pricing data (number of venues, venue implied-vol dispersion, quote freshness, pricer errors)?",
    criteria: ["poor: fewer than 2 venues, stale quotes, or large disagreement", "fair: usable but thin or somewhat dispersed", "good: several fresh venues that agree"],
  },
  user_fit: {
    type: "choice",
    instructions: "Does the proposed round match the user's stated patience (patient / balanced / eager) and goal?",
    criteria: {
      matches: "Size and expiry fit the user's stated patience.",
      too_aggressive: "Too large, too soon, or too likely to fill for the user's stated patience.",
      too_passive: "Too small or too far out for the user's stated patience; the user would wait longer than they asked.",
    },
  },
  explanation_ok: {
    type: "noul",
    instructions: "Is the Quant's rationale consistent with the numbers in the state (premiums, probabilities, events, dates)?",
  },
};
