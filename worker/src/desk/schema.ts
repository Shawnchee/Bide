import { z } from "zod";
import type { QuantProposal } from "./types.js";

/**
 * Quant output schema. Checks TYPES and on-chain integer RANGES only (u64 / u32 / i64), never
 * the user's plan bounds — bounds are the program's job (BUILD §0.2), so an out-of-bounds value
 * passes this schema and reaches open_round.
 */
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 2 ** 32 - 1;

/** u64 as a decimal string. Accepts a JS integer too (models often emit numbers) and normalises. */
export const u64 = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : "") : v.trim().replace(/_/g, "");
    if (!/^\d+$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a non-negative integer in base units (e.g. \"110000000\"), no decimals" });
      return z.NEVER;
    }
    const b = BigInt(s);
    if (b > U64_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exceeds u64" });
      return z.NEVER;
    }
    return b.toString();
  });

const i64Secs = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be unix seconds");
const u32 = z.number().int().min(0).max(U32_MAX);

const base = z.object({
  action: z.enum(["open", "skip", "flip", "stop"]),
  strike: u64.nullable().optional(),
  size: u64.nullable().optional(),
  expiry: z.union([i64Secs, z.string().regex(/^\d+$/).transform(Number)]).nullable().optional(),
  auction_secs: u32.nullable().optional(),
  premium_start: u64.nullable().optional(),
  premium_floor: u64.nullable().optional(),
  rationale: z.string().min(1).max(4000),
});

export const quantProposalSchema = base.strict().superRefine((p, ctx) => {
  if (p.action === "open") {
    for (const k of ["strike", "size", "expiry", "auction_secs", "premium_start", "premium_floor"] as const) {
      if (p[k] === null || p[k] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "required when action is \"open\"" });
    }
  }
}).transform((p): QuantProposal => {
  const open = p.action === "open";
  return {
    action: p.action,
    strike: open ? (p.strike as string) : null,
    size: open ? (p.size as string) : null,
    expiry: open ? (p.expiry as number) : null,
    auction_secs: open ? (p.auction_secs as number) : null,
    premium_start: open ? (p.premium_start as string) : null,
    premium_floor: open ? (p.premium_floor as string) : null,
    rationale: p.rationale,
  };
});

/** JSON shown to the model in the prompt (documentation, not enforced by the API). */
export const QUANT_OUTPUT_SHAPE = `{
  "action": "open" | "skip" | "flip" | "stop",
  "strike": "<u64 string, USDC base units per 1 whole asset, e.g. \\"110000000\\" for $110>" | null,
  "size": "<u64 string, asset base units, e.g. \\"200000000\\" for 0.2 SOL>" | null,
  "expiry": <integer unix seconds of an epoch expiry> | null,
  "auction_secs": <integer seconds> | null,
  "premium_start": "<u64 string, USDC base units, total for the round>" | null,
  "premium_floor": "<u64 string, USDC base units, total for the round>" | null,
  "rationale": "<2-4 plain sentences citing the tool numbers you used>"
}`;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Pull the first JSON object out of model text (tolerates ```json fences and leading prose). */
export function extractJsonObject(text: string): ParseResult<unknown> {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1]!.trim() : t;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "no JSON object found in the reply" };
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
}

export function formatZodError(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseQuantProposal(text: string): ParseResult<QuantProposal> {
  const j = extractJsonObject(text);
  if (!j.ok) return j;
  const r = quantProposalSchema.safeParse(j.value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: formatZodError(r.error) };
}
