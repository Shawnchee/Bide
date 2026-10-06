/** Typed desk errors. Callers switch on `code`, never on message text. */
export type DeskErrorCode =
  | "MISSING_SECRET" // an env key needed for this call is not set (ZAI_API_KEY, CF_ACCOUNT_ID, ...)
  | "MODEL_HTTP" // model endpoint returned non-2xx
  | "MODEL_RESPONSE" // model endpoint returned an unparseable / unexpected body
  | "QUANT_OUTPUT_INVALID" // Quant output failed the schema twice (after one repair)
  | "QUANT_NO_ANSWER" // Quant used every tool round and still did not answer
  | "RISK_OUTPUT_INVALID"
  | "RISK_UNAVAILABLE" // every risk backend failed
  | "TOOL_FAILED"
  | "CONFIG";

export class DeskError extends Error {
  readonly code: DeskErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: DeskErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "DeskError";
    this.code = code;
    this.detail = detail;
  }
}

export class MissingSecretError extends DeskError {
  readonly envName: string;
  constructor(envName: string, purpose: string) {
    super("MISSING_SECRET", `${envName} is not set (needed for ${purpose}). Add it to the env file; the desk will not call the model without it.`, { env: envName });
    this.name = "MissingSecretError";
    this.envName = envName;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof DeskError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
