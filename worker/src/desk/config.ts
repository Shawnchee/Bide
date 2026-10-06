import type { RiskBackendName } from "./types.js";
import { DeskError } from "./errors.js";

/**
 * Desk configuration from env. Secrets are read here but never logged; `describeDeskEnv` prints
 * NAME + SET/EMPTY only. A missing key does NOT throw at load time — the adapter that needs it
 * throws MissingSecretError when it is first called, so the rest of the worker still runs.
 */
export interface DeskConfig {
  zai: {
    apiKey: string | undefined;
    /** VERIFY: standard endpoint vs GLM Coding Plan endpoint (BUILD §5). */
    baseUrl: string;
    modelMain: string;
    /** Optional separate model for the GLM risk fallback; defaults to modelMain. */
    modelRisk: string;
    timeoutMs: number;
  };
  risk: {
    backend: RiskBackendName;
    cfAccountId: string | undefined;
    cfToken: string | undefined;
    /** "clef" or "clef-flash". */
    clefModel: "clef" | "clef-flash";
    localUrl: string | undefined;
    timeoutMs: number;
  };
  quant: { maxToolRounds: number };
}

/** Standard Z.ai endpoint (docs.z.ai). Coding-plan keys use https://api.z.ai/api/coding/paas/v4. */
export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";

const empty = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

export function readDeskConfig(env: Record<string, string | undefined> = process.env): DeskConfig {
  const backendRaw = empty(env.RISK_BACKEND) ?? "workers-ai";
  if (!["glm", "workers-ai", "local"].includes(backendRaw)) {
    throw new DeskError("CONFIG", `RISK_BACKEND must be glm | workers-ai | local (got "${backendRaw}")`);
  }
  const clefModel = (empty(env.CLEF_MODEL) ?? "clef") as "clef" | "clef-flash";
  if (clefModel !== "clef" && clefModel !== "clef-flash") throw new DeskError("CONFIG", `CLEF_MODEL must be clef | clef-flash`);
  const modelMain = empty(env.ZAI_MODEL_MAIN) ?? "glm-5.3";
  return {
    zai: {
      apiKey: empty(env.ZAI_API_KEY),
      baseUrl: (empty(env.ZAI_BASE_URL) ?? ZAI_DEFAULT_BASE_URL).replace(/\/+$/, ""),
      modelMain,
      modelRisk: empty(env.ZAI_MODEL_RISK) ?? modelMain,
      timeoutMs: Number(empty(env.ZAI_TIMEOUT_MS) ?? 120_000),
    },
    risk: {
      backend: backendRaw as RiskBackendName,
      cfAccountId: empty(env.CF_ACCOUNT_ID),
      cfToken: empty(env.CF_AI_TOKEN),
      clefModel,
      localUrl: empty(env.CLEF_LOCAL_URL),
      timeoutMs: Number(empty(env.RISK_TIMEOUT_MS) ?? 30_000),
    },
    quant: { maxToolRounds: Number(empty(env.DESK_MAX_TOOL_ROUNDS) ?? 8) },
  };
}

/** Safe to log: names + SET/EMPTY, never values. */
export function describeDeskEnv(env: Record<string, string | undefined> = process.env): string {
  const names = ["ZAI_API_KEY", "ZAI_BASE_URL", "ZAI_MODEL_MAIN", "ZAI_MODEL_RISK", "RISK_BACKEND", "CF_ACCOUNT_ID", "CF_AI_TOKEN", "CLEF_MODEL", "CLEF_LOCAL_URL"];
  return names.map((n) => `${n}=${empty(env[n]) ? "SET" : "EMPTY"}`).join(" ");
}
