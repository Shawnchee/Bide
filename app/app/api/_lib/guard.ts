// Early (non-authoritative) checks for public routes that spend LLM quota. The worker re-validates with the same rules
// (worker/src/http/limits.ts) and owns the rate limits, because serverless instances don't share memory.

const MAX_STRIKE = 10_000_000_000_000n;
const MAX_AMOUNT = 1_000_000_000_000_000n;
const EPOCH_MIN = 1_600_000_000;
const EPOCH_MAX = 4_102_444_800;

const u64 = (max: bigint) => (v: unknown) => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= max;
const int = (min: number, max: number) => (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const oneOf = (...xs: string[]) => (v: unknown) => typeof v === "string" && xs.includes(v);
const bool = (v: unknown) => typeof v === "boolean";
const horizon = (v: unknown) =>
  int(EPOCH_MIN, EPOCH_MAX)(v) ||
  (typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(v) && Number.isFinite(Date.parse(v)));

const PREVIEW_FIELDS: Record<string, { ok: (v: unknown) => boolean; required?: boolean }> = {
  asset: { ok: oneOf("SOL", "BTC") },
  side: { ok: oneOf("buy", "sell", "wheel"), required: true },
  quick: { ok: bool },
  target_strike: { ok: u64(MAX_STRIKE), required: true },
  exit_strike: { ok: u64(MAX_STRIKE) },
  lock_strike: { ok: bool },
  band: { ok: u64(MAX_STRIKE) },
  exit_band: { ok: u64(MAX_STRIKE) },
  size_total: { ok: u64(MAX_AMOUNT), required: true },
  min_premium_bps_per_day: { ok: int(1, 10_000), required: true },
  max_expiry_secs: { ok: int(60, 400 * 86_400), required: true },
  horizon_end: { ok: horizon, required: true },
  max_rounds_per_day: { ok: int(1, 288) },
  owner: { ok: (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) },
  patience: { ok: oneOf("patient", "balanced", "eager") },
};

/** Validated draft, or an error naming the first bad field. Unknown keys are rejected; null/undefined optionals dropped. */
export function checkPreviewDraft(raw: unknown): { draft: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid body" };
  const draft: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const spec = PREVIEW_FIELDS[k];
    if (!spec) return { error: `unknown field: ${k.slice(0, 40)}` };
    if (v === undefined || v === null) continue;
    if (!spec.ok(v)) return { error: `invalid ${k}` };
    draft[k] = v;
  }
  for (const [k, spec] of Object.entries(PREVIEW_FIELDS)) if (spec.required && !(k in draft)) return { error: `${k} is required` };
  return { draft };
}

export const INTAKE_MAX_TEXT = 500;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
export const cleanIntakeText = (s: string) => s.replace(CONTROL, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Caller IP for rate limiting. Prefer x-real-ip (Vercel's edge overwrites it with the real client address), else the
 * LAST x-forwarded-for hop (appended by the nearest proxy). Never the first hop: a client can send any x-forwarded-for
 * it likes and the first entry is whatever it wrote. Only IP-shaped values are forwarded; otherwise none.
 */
export function clientIp(req: Request): string | null {
  const ipLike = (v: string | null | undefined) => {
    const ip = v?.trim() ?? "";
    return /^[0-9a-fA-F:.]{2,64}$/.test(ip) ? ip : null;
  };
  const real = ipLike(req.headers.get("x-real-ip"));
  if (real) return real;
  const hops = req.headers.get("x-forwarded-for")?.split(",") ?? [];
  return ipLike(hops[hops.length - 1]);
}

/** Relay a worker response; keeps 429 + Retry-After intact. */
export async function relay(res: Response): Promise<Response> {
  const body = await res.json().catch(() => null);
  const headers = new Headers();
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") ?? (body as { retry_after?: number } | null)?.retry_after ?? 30);
    const secs = Number.isFinite(ra) && ra > 0 ? Math.min(Math.ceil(ra), 600) : 30;
    headers.set("Retry-After", String(secs));
    return Response.json({ error: "busy", retry_after: secs }, { status: 429, headers });
  }
  return Response.json(body ?? { error: "bad worker response" }, { status: res.status });
}
