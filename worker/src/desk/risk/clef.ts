/**
 * Cloudflare Clef backends: `workers-ai` (REST) and `local` (our own HTTP wrapper around the
 * official Clef-flash joint-schema script, same body/response contract).
 *
 * CONFIRMED (developers.cloudflare.com/workers-ai/models/clef, 2026-10-05):
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef
 *   Authorization: Bearer <token>; body {model: "clef"|"clef-flash", state, questions{id: {...}}};
 *   result {model, answers{id: ...}, usage}.
 * ASSUMED (secondary source flaviocopes.com/clef; VERIFY with one real call):
 *   REST envelope {result, success, errors, messages};
 *   choice answer {type, choice, probabilities{option: p}, confidence};
 *   score answer {score, legend, probabilities, confidence}; noul answer = probability (number)
 *   or {probability}. CONFIRMED live 2026-10-06: choice {type, choice, probabilities, confidence};
 *   score {type, score, legend, probabilities}; noul {type:"noul", noul: p}; body model must be
 *   "clef" | "clef-flash". The parser below accepts all of these shapes and fails loudly otherwise.
 */
import type { RiskAnswers } from "../types.js";
import { DeskError, MissingSecretError } from "../errors.js";
import { RISK_QUESTIONS, SCORE_KEYS } from "./questions.js";
import { normalise } from "./binding.js";
import { canonicalJson } from "../canonical.js";

export interface ClefCallResult {
  model: string;
  answers: RiskAnswers;
  raw: unknown;
}

export function clefRequestBody(model: "clef" | "clef-flash", state: unknown) {
  // `state` sent as canonical JSON text so the exact bytes are reproducible from the memo.
  return { model, state: canonicalJson(state), questions: RISK_QUESTIONS };
}

export async function callClefWorkersAi(o: {
  accountId: string | undefined;
  token: string | undefined;
  model: "clef" | "clef-flash";
  state: unknown;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ClefCallResult> {
  if (!o.accountId) throw new MissingSecretError("CF_ACCOUNT_ID", "Cloudflare Workers AI (Clef risk)");
  if (!o.token) throw new MissingSecretError("CF_AI_TOKEN", "Cloudflare Workers AI (Clef risk)");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(o.accountId)}/ai/run/@cf/cloudflare/${o.model}`;
  return postClef(url, { authorization: `Bearer ${o.token}` }, o.model, o.state, o.timeoutMs, o.fetchImpl ?? fetch, "workers-ai");
}

export async function callClefLocal(o: { url: string | undefined; model: "clef" | "clef-flash"; state: unknown; timeoutMs: number; fetchImpl?: typeof fetch }): Promise<ClefCallResult> {
  if (!o.url) throw new MissingSecretError("CLEF_LOCAL_URL", "the local Clef-flash service");
  return postClef(o.url, {}, o.model, o.state, o.timeoutMs, o.fetchImpl ?? fetch, "local");
}

async function postClef(url: string, headers: Record<string, string>, model: "clef" | "clef-flash", state: unknown, timeoutMs: number, f: typeof fetch, label: string): Promise<ClefCallResult> {
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(clefRequestBody(model, state)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new DeskError("MODEL_HTTP", `Clef (${label}) request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new DeskError("MODEL_HTTP", `Clef (${label}) HTTP ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DeskError("MODEL_RESPONSE", `Clef (${label}) non-JSON body: ${text.slice(0, 200)}`);
  }
  return parseClefResponse(body, model);
}

/** Accepts the REST envelope or a bare result. Exported for fixture tests. */
export function parseClefResponse(body: any, fallbackModel: string): ClefCallResult {
  if (body && body.success === false) throw new DeskError("MODEL_RESPONSE", `Clef error: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  const result = body?.result && typeof body.result === "object" && "answers" in body.result ? body.result : body;
  const ans = result?.answers;
  if (!ans || typeof ans !== "object") throw new DeskError("RISK_OUTPUT_INVALID", "Clef response has no answers object");
  try {
    const answers: RiskAnswers = {
      verdict: choiceProbs(ans.verdict, ["approve", "adjust", "veto"]),
      event_risk: scoreProbs(ans.event_risk, SCORE_KEYS.event_risk, RISK_QUESTIONS.event_risk),
      data_quality: scoreProbs(ans.data_quality, SCORE_KEYS.data_quality, RISK_QUESTIONS.data_quality),
      user_fit: choiceProbs(ans.user_fit, ["matches", "too_aggressive", "too_passive"]),
      explanation_ok: noulProbs(ans.explanation_ok),
    };
    return { model: String(result.model ?? fallbackModel), answers, raw: result };
  } catch (e) {
    throw new DeskError("RISK_OUTPUT_INVALID", `Clef answers not in the expected shape: ${(e as Error).message}`, { answers: ans });
  }
}

function choiceProbs<K extends string>(a: any, keys: readonly K[]): Record<K, number> {
  if (!a || typeof a !== "object") throw new Error("choice answer missing");
  if (a.probabilities && typeof a.probabilities === "object") return normalise(keys, a.probabilities);
  if (typeof a.choice === "string" && keys.includes(a.choice)) {
    // No distribution returned: put the stated confidence on the choice (or 1).
    const c = typeof a.confidence === "number" ? a.confidence : 1;
    const rest = (1 - c) / (keys.length - 1);
    return normalise(keys, Object.fromEntries(keys.map((k) => [k, k === a.choice ? c : rest])));
  }
  throw new Error("choice answer has neither probabilities nor a known choice");
}

function scoreProbs<K extends string>(a: any, keys: readonly K[], q: { criteria: string[] } | any): Record<K, number> {
  if (a && typeof a === "object" && a.probabilities) {
    const p = a.probabilities;
    if (Array.isArray(p)) return normalise(keys, Object.fromEntries(keys.map((k, i) => [k, p[i]])));
    // Keyed by full label, by our key, or by index.
    const labels: string[] = q.criteria;
    return normalise(keys, Object.fromEntries(keys.map((k, i) => [k, p[labels[i]!] ?? p[k] ?? p[String(i)] ?? 0])));
  }
  const s = typeof a === "number" ? a : typeof a?.score === "number" ? a.score : null;
  if (s === null) throw new Error("score answer has neither probabilities nor a score");
  // Only an expected score (0 = lowest level): split it between the two neighbouring levels.
  const x = Math.min(Math.max(s, 0), keys.length - 1);
  const lo = Math.floor(x);
  const hi = Math.min(lo + 1, keys.length - 1);
  const raw: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  raw[keys[lo]!] = (raw[keys[lo]!] ?? 0) + (hi === lo ? 1 : hi - x);
  if (hi !== lo) raw[keys[hi]!] = (raw[keys[hi]!] ?? 0) + (x - lo);
  return normalise(keys, raw);
}

function noulProbs(a: any): Record<"yes" | "no", number> {
  const p = typeof a === "number" ? a : typeof a?.noul === "number" ? a.noul : typeof a?.probability === "number" ? a.probability : typeof a?.score === "number" ? a.score : null;
  if (p === null || p < 0 || p > 1) throw new Error(`noul answer is not a probability in [0,1]: ${JSON.stringify(a).slice(0, 300)}`);
  return { yes: p, no: 1 - p };
}
