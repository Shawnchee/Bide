/** GLM strict-JSON risk fallback: same questions, same option keys, probabilities per option. */
import { z } from "zod";
import type { ChatTransport } from "../llm/chat.js";
import type { RiskAnswers } from "../types.js";
import { DeskError } from "../errors.js";
import { RISK_QUESTIONS, SCORE_KEYS } from "./questions.js";
import { normalise } from "./binding.js";
import { extractJsonObject, formatZodError } from "../schema.js";
import { canonicalJson } from "../canonical.js";

const probs = (keys: readonly string[]) => z.object(Object.fromEntries(keys.map((k) => [k, z.number().min(0).max(1)]))).strict();

export const glmRiskSchema = z
  .object({
    verdict: probs(["approve", "adjust", "veto"]),
    event_risk: probs(SCORE_KEYS.event_risk),
    data_quality: probs(SCORE_KEYS.data_quality),
    user_fit: probs(["matches", "too_aggressive", "too_passive"]),
    explanation_ok: probs(["yes", "no"]),
  })
  .strict();

function questionText(): string {
  const lines: string[] = [];
  for (const [id, q] of Object.entries(RISK_QUESTIONS)) {
    if (q.type === "choice") lines.push(`- ${id} (options ${Object.keys(q.criteria).join(" / ")}): ${q.instructions} ${Object.entries(q.criteria).map(([k, v]) => `[${k}] ${v}`).join(" ")}`);
    else if (q.type === "score") {
      const keys = SCORE_KEYS[id as keyof typeof SCORE_KEYS];
      lines.push(`- ${id} (options ${keys.join(" / ")}): ${q.instructions} ${q.criteria.map((c) => `[${c}]`).join(" ")}`);
    } else lines.push(`- ${id} (options yes / no): ${q.instructions}`);
  }
  return lines.join("\n");
}

export const GLM_RISK_SYSTEM = `You are a risk reviewer. You answer typed questions about a proposed options round with probabilities, not prose.
For every question give a probability for every option; each question's probabilities sum to 1.
Questions:
${questionText()}
Reply with ONLY a JSON object of this exact shape (numbers in [0,1]):
{"verdict":{"approve":p,"adjust":p,"veto":p},"event_risk":{"none":p,"low":p,"medium":p,"high":p},"data_quality":{"poor":p,"fair":p,"good":p},"user_fit":{"matches":p,"too_aggressive":p,"too_passive":p},"explanation_ok":{"yes":p,"no":p}}`;

export async function callGlmRisk(o: { transport: ChatTransport; model: string; state: unknown }): Promise<{ model: string; answers: RiskAnswers; raw: unknown }> {
  const messages = [
    { role: "system" as const, content: GLM_RISK_SYSTEM },
    { role: "user" as const, content: canonicalJson({ state: o.state }) },
  ];
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await o.transport.complete({ model: o.model, messages, response_format: { type: "json_object" }, temperature: 0 });
    const text = res.content ?? "";
    const j = extractJsonObject(text);
    if (j.ok) {
      const r = glmRiskSchema.safeParse(j.value);
      if (r.success) {
        const d = r.data;
        const answers: RiskAnswers = {
          verdict: normalise(["approve", "adjust", "veto"], d.verdict),
          event_risk: normalise(SCORE_KEYS.event_risk, d.event_risk),
          data_quality: normalise(SCORE_KEYS.data_quality, d.data_quality),
          user_fit: normalise(["matches", "too_aggressive", "too_passive"], d.user_fit),
          explanation_ok: normalise(["yes", "no"], d.explanation_ok),
        };
        return { model: res.model || o.model, answers, raw: d };
      }
      lastErr = formatZodError(r.error);
    } else lastErr = j.error;
    messages.push({ role: "assistant" as any, content: text } as any);
    messages.push({ role: "user", content: `Invalid: ${lastErr}. Reply with ONLY the JSON object in the exact shape.` });
  }
  throw new DeskError("RISK_OUTPUT_INVALID", `GLM risk output invalid after one repair: ${lastErr}`);
}
