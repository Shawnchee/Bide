// Anchor custom errors start at 6000; parseProgramError prefers names found in logs.
// Source of truth: packages/shared (P lane) — includes additions beyond BUILD §3.4.
import { BIDE_ERRORS } from "@bide/shared";
export { BIDE_ERRORS };
export type BideErrorName = (typeof BIDE_ERRORS)[number];

export interface ParsedError { code?: number; name?: string; message: string; logs?: string[]; retryable: boolean }

const TRANSIENT = /(blockhash not found|block height exceeded|timed? ?out|429|too many requests|ECONNRESET|fetch failed|node is behind|socket hang up|503|502)/i;

/** Extract an Anchor error code/name from a send error (SendTransactionError, AnchorError, plain Error). */
export function parseProgramError(e: unknown, names: readonly string[] = BIDE_ERRORS): ParsedError {
  const err = e as any;
  const logs: string[] | undefined = err?.logs ?? err?.transactionLogs ?? err?.simulationResponse?.logs;
  const message = String(err?.message ?? err);
  // AnchorError object
  const anchorCode = err?.error?.errorCode;
  if (anchorCode?.code) return { code: anchorCode.number, name: anchorCode.code, message, logs, retryable: false };
  // "Error Code: StrikeOutOfBounds. Error Number: 6008." in logs
  const joined = [message, ...(logs ?? [])].join("\n");
  const m = /Error Code: (\w+)\. Error Number: (\d+)/.exec(joined);
  if (m) return { name: m[1], code: Number(m[2]), message, logs, retryable: false };
  // "custom program error: 0x1770"
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(joined);
  if (hex) {
    const code = parseInt(hex[1]!, 16);
    const name = code >= 6000 ? names[code - 6000] : undefined;
    return { code, name, message, logs, retryable: false };
  }
  return { message, logs, retryable: TRANSIENT.test(joined) };
}
