/** AI agents v2 env (names only are ever logged). */
const empty = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

export interface AgentConfig {
  /** MAKER_LLM=1 → maker stances from GLM; default on when ZAI_API_KEY is set. "0" forces the deterministic makers. */
  makerLlm: boolean;
  makerTimeoutMs: number;
  /** Decide stances this many seconds before an epoch's auction window opens. */
  stanceLeadSecs: number;
  /** Hard cap on maker GLM calls per rolling hour (quota guard); over it → fallback. */
  makerMaxCallsPerHour: number;
  intakeEnabled: boolean;
  intakeTimeoutMs: number;
  intakeMaxPerMinute: number;
  model: string;
}

export function readAgentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const hasKey = Boolean(empty(env.ZAI_API_KEY));
  const flag = empty(env.MAKER_LLM) ?? empty(env.AI_MAKERS);
  return {
    makerLlm: hasKey && (flag === undefined ? true : flag === "1"),
    makerTimeoutMs: Number(empty(env.MAKER_LLM_TIMEOUT_MS) ?? 300_000),
    stanceLeadSecs: Number(empty(env.MAKER_STANCE_LEAD_SECS) ?? 240),
    makerMaxCallsPerHour: Number(empty(env.MAKER_LLM_MAX_PER_HOUR) ?? 30),
    intakeEnabled: hasKey && (empty(env.INTAKE_ENABLED) ?? "1") === "1",
    intakeTimeoutMs: Number(empty(env.INTAKE_TIMEOUT_MS) ?? 120_000),
    intakeMaxPerMinute: Number(empty(env.INTAKE_MAX_PER_MINUTE) ?? 6),
    model: empty(env.ZAI_MODEL_AGENTS) ?? empty(env.ZAI_MODEL_MAIN) ?? "glm-5.3",
  };
}

export function describeAgentEnv(env: Record<string, string | undefined> = process.env): string {
  return ["MAKER_LLM", "MAKER_LLM_TIMEOUT_MS", "MAKER_STANCE_LEAD_SECS", "MAKER_LLM_MAX_PER_HOUR", "INTAKE_ENABLED", "INTAKE_MAX_PER_MINUTE", "ZAI_MODEL_AGENTS"]
    .map((n) => `${n}=${empty(env[n]) ? "SET" : "EMPTY"}`).join(" ");
}
