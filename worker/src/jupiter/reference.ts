// Jupiter reference data (BUILD §4.0): mainnet Lend APY + SOL price for UI/desk. Never used for settlement
// or devnet balances (no Jupiter REST API has a devnet mode). Keyless = 0.5 RPS; JUP_API_KEY = 1 RPS.
import { cfg } from "../config.js";
import { logger } from "../log.js";
import type { Repo } from "../db/types.js";

const log = logger("jupiter");
export const MAINNET_SOL = "So11111111111111111111111111111111111111112";
const BASE = "https://api.jup.ag";
const CACHE_MS = 60_000;

/** Serialises requests with a minimum gap (2 s keyless, 1 s with key) and backs off on 429. */
export class RateLimiter {
  private next = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private minGapMs: number, private nowFn = () => Date.now(), private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const wait = this.next - this.nowFn();
      if (wait > 0) await this.sleep(wait);
      this.next = this.nowFn() + this.minGapMs;
      return fn();
    });
    this.chain = p.catch(() => undefined);
    return p;
  }
  penalise(ms: number) { this.next = Math.max(this.next, this.nowFn() + ms); }
}

export interface LendApy { symbol: string; mint: string; supplyBps: number; rewardsBps: number; totalBps: number }
export interface JupReference { lend: LendApy[]; solPriceUsd: number | null; fetchedAt: number; source: "mainnet reference" }

export function parseEarnTokens(raw: any): LendApy[] {
  const arr: any[] = Array.isArray(raw) ? raw : raw?.data ?? [];
  return arr.map((t) => ({
    symbol: t.asset?.symbol ?? t.symbol, mint: t.assetAddress ?? t.asset?.address,
    supplyBps: Number(t.supplyRate ?? 0), rewardsBps: Number(t.rewardsRate ?? 0), totalBps: Number(t.totalRate ?? Number(t.supplyRate ?? 0) + Number(t.rewardsRate ?? 0)),
  }));
}
export const parsePrice = (raw: any, mint = MAINNET_SOL): number | null => {
  const p = raw?.[mint]?.usdPrice;
  return typeof p === "number" ? p : null;
};

export class JupiterReference {
  private limiter = new RateLimiter(cfg.jupApiKey ? 1_000 : 2_000);
  private cache: JupReference | null = null;
  constructor(private repo?: Repo) {}

  private async get(path: string): Promise<any> {
    return this.limiter.run(async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (cfg.jupApiKey) headers["x-api-key"] = cfg.jupApiKey;
      const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 429) { this.limiter.penalise(10_000); throw new Error("jupiter 429"); }
      if (!res.ok) throw new Error(`jupiter HTTP ${res.status} ${path.split("?")[0]}`);
      return res.json();
    });
  }

  /** Cached for 60 s; on failure returns the last good value (memory, then Supabase). */
  async get60s(): Promise<JupReference | null> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_MS) return this.cache;
    return this.refresh();
  }

  async refresh(): Promise<JupReference | null> {
    try {
      const earn = await this.get("/lend/v1/earn/tokens");
      const price = await this.get(`/price/v3?ids=${MAINNET_SOL}`);
      this.cache = { lend: parseEarnTokens(earn), solPriceUsd: parsePrice(price), fetchedAt: Date.now(), source: "mainnet reference" };
      await this.repo?.setReference("jupiter", this.cache).catch((e) => log.warn("cache write failed", { err: (e as Error).message }));
      return this.cache;
    } catch (e) {
      log.warn("refresh failed", { err: (e as Error).message });
      if (!this.cache && this.repo) {
        const r = await this.repo.getReference("jupiter").catch(() => null);
        if (r) this.cache = r.value as JupReference;
      }
      return this.cache;
    }
  }
  peek() { return this.cache; }
}
