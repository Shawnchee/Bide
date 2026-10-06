// Public-route abuse controls (desk preview + intake): strict input schemas, sliding-window budgets, preview cache.
// The worker is the authority: Vercel serverless instances don't share memory, so the app's checks are only early exits.
import { z } from "zod";

// ---------------- schemas ----------------
const MAX_STRIKE = 10_000_000_000_000n; // $10M in 1e-6 USD units
const MAX_AMOUNT = 1_000_000_000_000_000n; // 1e15 base units (1M SOL at 9 dp)
const u64Max = (max: bigint) =>
  z.string().regex(/^(0|[1-9]\d{0,19})$/, "must be a non-negative integer string").refine((s) => /^\d{1,20}$/.test(s) && BigInt(s) <= max, `must be <= ${max}`);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const EPOCH_MIN = 1_600_000_000, EPOCH_MAX = 4_102_444_800; // 2020 .. 2100
const horizon = z.union([
  int(EPOCH_MIN, EPOCH_MAX),
  z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/, "must be ISO-8601")
    .transform((s, ctx) => {
      const ms = Date.parse(s);
      const secs = Math.floor(ms / 1000);
      if (!Number.isFinite(ms) || secs < EPOCH_MIN || secs > EPOCH_MAX) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bad date" }); return z.NEVER; }
      return secs;
    }),
]);

/** Desk preview draft. Unknown keys are rejected; every string is enum/regex-bounded (nothing free-form reaches the LLM). */
export const PreviewBody = z.object({
  asset: z.enum(["SOL", "BTC"]).default("SOL"),
  side: z.enum(["buy", "sell", "wheel"]),
  quick: z.boolean().default(false),
  target_strike: u64Max(MAX_STRIKE),
  exit_strike: u64Max(MAX_STRIKE).optional(),
  lock_strike: z.boolean().default(true),
  band: u64Max(MAX_STRIKE).optional(),
  exit_band: u64Max(MAX_STRIKE).optional(),
  size_total: u64Max(MAX_AMOUNT),
  min_premium_bps_per_day: int(1, 10_000),
  max_expiry_secs: int(60, 400 * 86_400),
  horizon_end: horizon,
  max_rounds_per_day: int(1, 288).optional(),
  owner: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 public key").optional(),
  patience: z.enum(["patient", "balanced", "eager"]).optional(),
}).strict();
export type PreviewInput = z.infer<typeof PreviewBody>;

export const INTAKE_MAX_TEXT = 500;
// C0/C1 controls (except \t \n), bidi overrides/isolates, zero-width chars, BOM.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
export const cleanIntakeText = (s: string) => s.replace(CONTROL, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
export const IntakeBody = z.object({
  text: z.string().max(4 * INTAKE_MAX_TEXT).transform(cleanIntakeText)
    .pipe(z.string().min(1, "text is required").max(INTAKE_MAX_TEXT, `keep it under ${INTAKE_MAX_TEXT} characters`)),
}).strict();

/** Stable JSON (sorted keys) for cache keys. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// ---------------- budgets ----------------
/** Sliding one-window counter per key. `check` doesn't record; call `hit` once every gate has passed. */
export class SlidingLimiter {
  private hits = new Map<string, number[]>();
  constructor(readonly max: number, readonly windowMs = 60_000, private now: () => number = Date.now) {}
  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const xs = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (xs.length) this.hits.set(key, xs); else this.hits.delete(key);
    return xs;
  }
  /** 0 when allowed, else seconds until a slot frees. */
  check(key = "*"): number {
    const xs = this.live(key);
    if (xs.length < this.max) return 0;
    return Math.max(1, Math.ceil((xs[0] + this.windowMs - this.now()) / 1000));
  }
  hit(key = "*") { const xs = this.live(key); xs.push(this.now()); this.hits.set(key, xs); }
}

/** Client IP forwarded by the app as X-Client-IP. Anything that isn't IP-shaped shares one "unknown" bucket. */
export function clientKey(header: string | undefined): string {
  const v = (header ?? "").trim();
  return v.length <= 64 && /^[0-9a-fA-F:.]{2,64}$/.test(v) ? v.toLowerCase() : "unknown";
}

const envInt = (env: Record<string, string | undefined>, k: string, d: number) => {
  const n = Number(env[k]);
  return env[k] && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export interface HttpLimits {
  previewPerMinute: number;
  previewPerIpPerMinute: number;
  intakePerMinute: number;
  intakePerIpPerMinute: number;
  /** Public low-lane runs: queued beyond the 1 running (→ 429 when full). */
  lowBacklog: number;
  previewCacheMs: number;
}

export function readHttpLimits(env: Record<string, string | undefined> = process.env): HttpLimits {
  return {
    previewPerMinute: envInt(env, "PREVIEW_MAX_PER_MINUTE", 4),
    previewPerIpPerMinute: envInt(env, "PREVIEW_MAX_PER_IP_PER_MINUTE", 2),
    intakePerMinute: envInt(env, "INTAKE_MAX_PER_MINUTE", 6),
    intakePerIpPerMinute: envInt(env, "INTAKE_MAX_PER_IP_PER_MINUTE", 2),
    lowBacklog: envInt(env, "PUBLIC_LLM_BACKLOG", 3),
    previewCacheMs: 60_000,
  };
}

/** Identical preview drafts within `ttlMs` reuse the same desk run id. */
export class PreviewCache {
  private m = new Map<string, { runId: string; at: number }>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}
  get(key: string): string | null {
    const e = this.m.get(key);
    if (!e) return null;
    if (this.now() - e.at > this.ttlMs) { this.m.delete(key); return null; }
    return e.runId;
  }
  set(key: string, runId: string) {
    this.m.set(key, { runId, at: this.now() });
    if (this.m.size > 500) for (const [k, v] of this.m) if (this.now() - v.at > this.ttlMs) this.m.delete(k);
  }
  drop(key: string, runId: string) { if (this.m.get(key)?.runId === runId) this.m.delete(key); }
}
