/**
 * RiskJudge adapter. Order: the configured backend first; if it fails and it is not `glm`,
 * fall back to the GLM strict-JSON judge (BUILD §5). If every backend fails → RISK_UNAVAILABLE
 * (the orchestrator then does NOT open a round: fail closed).
 */
import type { ChatTransport } from "../llm/chat.js";
import type { RiskBackendName, RiskResult } from "../types.js";
import { DeskError, errorMessage } from "../errors.js";
import { callClefLocal, callClefWorkersAi } from "./clef.js";
import { callGlmRisk } from "./glm.js";

export interface RiskJudge {
  readonly order: RiskBackendName[];
  judge(state: unknown): Promise<RiskResult>;
}

export interface RiskJudgeOptions {
  backend: RiskBackendName;
  glm: { transport: ChatTransport; model: string };
  clef: { accountId?: string; token?: string; model: "clef" | "clef-flash"; localUrl?: string; timeoutMs: number; fetchImpl?: typeof fetch };
  /** Default true. Set false to surface primary-backend errors without falling back. */
  fallbackToGlm?: boolean;
}

export function createRiskJudge(o: RiskJudgeOptions): RiskJudge {
  const order: RiskBackendName[] = o.backend === "glm" || o.fallbackToGlm === false ? [o.backend] : [o.backend, "glm"];
  return {
    order,
    async judge(state) {
      const fallbacks: RiskResult["fallbacks"] = [];
      for (const b of order) {
        try {
          const r =
            b === "glm"
              ? await callGlmRisk({ transport: o.glm.transport, model: o.glm.model, state })
              : b === "workers-ai"
                ? await callClefWorkersAi({ accountId: o.clef.accountId, token: o.clef.token, model: o.clef.model, state, timeoutMs: o.clef.timeoutMs, fetchImpl: o.clef.fetchImpl })
                : await callClefLocal({ url: o.clef.localUrl, model: o.clef.model, state, timeoutMs: o.clef.timeoutMs, fetchImpl: o.clef.fetchImpl });
          return { backend: b, model: r.model, answers: r.answers, fallbacks, raw: r.raw };
        } catch (e) {
          fallbacks.push({ backend: b, error: errorMessage(e) });
        }
      }
      throw new DeskError("RISK_UNAVAILABLE", `all risk backends failed: ${fallbacks.map((f) => `${f.backend}: ${f.error}`).join(" | ")}`, { fallbacks });
    },
  };
}
