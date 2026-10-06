// Robust RPC transport (integration run #2). Run #1 lost a whole quick sampling window because one RPC request
// never returned: web3.js Connection has no per-request timeout and undici's default headersTimeout is 300 s.
// Here every JSON-RPC request gets an AbortSignal timeout, and a timeout / network error / 5xx / 429 on the primary
// (Helius) is retried once on the fallback (public devnet — rate-limited, so fallback only, never primary).
// URLs are never logged (the Helius URL carries an api-key); only the labels "primary" / "fallback".
import { Connection, type Commitment } from "@solana/web3.js";
import { cfg, readEnv } from "../config.js";
import { logger } from "../log.js";

const log = logger("rpc");

export type FetchFn = (input: any, init?: any) => Promise<Response>;

export interface RpcStats { requests: number; timeouts: number; primaryFailures: number; fallbacks: number; fallbackFailures: number; lastError: string | null }
const allStats = new Map<string, RpcStats>();
export const rpcStats = () => Object.fromEntries(allStats);

export interface RpcFetchOpts {
  primary: string;
  fallback?: string;
  timeoutMs: number;
  label: string;
  /** Underlying fetch (tests). */
  fetchImpl?: FetchFn;
}

const isRetryableStatus = (s: number) => s === 429 || s >= 500;
const describe = (e: unknown) => {
  const err = e as any;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return String(err?.cause?.code ?? err?.message ?? err).slice(0, 120);
};

/**
 * A fetch for web3.js `Connection({ fetch })`: per-request timeout on the primary, then one try on the fallback.
 * Never hangs longer than ~2 × timeoutMs. Throws (→ web3.js "failed to get …") if both fail.
 */
export function makeRpcFetch(o: RpcFetchOpts): FetchFn {
  const f: FetchFn = o.fetchImpl ?? ((i, n) => fetch(i, n));
  const stats: RpcStats = { requests: 0, timeouts: 0, primaryFailures: 0, fallbacks: 0, fallbackFailures: 0, lastError: null };
  allStats.set(o.label, stats);
  const attempt = (url: string, init: any) => {
    const signals = [AbortSignal.timeout(o.timeoutMs), ...(init?.signal ? [init.signal] : [])];
    return f(url, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
  };
  return async (_input: any, init?: any) => {
    stats.requests++;
    let why: string;
    try {
      const res = await attempt(o.primary, init);
      if (!isRetryableStatus(res.status) || !o.fallback) return res;
      why = `HTTP ${res.status}`;
    } catch (e) {
      why = describe(e);
      if (why === "timeout") stats.timeouts++;
      // Always a plain Error: web3.js only calls back for `instanceof Error`, anything else would hang the call.
      if (!o.fallback) { stats.primaryFailures++; stats.lastError = why; throw new Error(`rpc ${o.label}: primary ${why}`); }
    }
    stats.primaryFailures++;
    stats.fallbacks++;
    stats.lastError = why;
    log.warn("rpc primary failed, using fallback", { conn: o.label, why });
    try {
      return await attempt(o.fallback!, init);
    } catch (e) {
      stats.fallbackFailures++;
      const w2 = describe(e);
      if (w2 === "timeout") stats.timeouts++;
      stats.lastError = `primary: ${why}; fallback: ${w2}`;
      throw new Error(`rpc ${o.label}: primary ${why}, fallback ${w2}`);
    }
  };
}

export const RPC_TIMEOUT_MS = Number(readEnv("RPC_TIMEOUT_MS") ?? 12_000);

/** One Connection per loop (keeper, makers, sampler, snapshot …): a stuck socket in one never blocks the others. */
export function makeConnection(label: string, commitment: Commitment = "confirmed"): Connection {
  const fallback = cfg.rpcFallbackUrl !== cfg.rpcUrl ? cfg.rpcFallbackUrl : undefined;
  return new Connection(cfg.rpcUrl, {
    commitment,
    fetch: makeRpcFetch({ primary: cfg.rpcUrl, fallback, timeoutMs: RPC_TIMEOUT_MS, label }) as any,
    // web3.js would otherwise sleep-and-retry 429s up to 5× inside one call; the fallback already covers 429.
    disableRetryOnRateLimit: true,
  });
}

/** Rejects after `ms` (the underlying promise keeps running; use only around already-bounded work). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}
