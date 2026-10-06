// Fixed-interval loops with per-loop error isolation, no overlap, and exponential backoff on repeated errors.
import { logger } from "../log.js";

const log = logger("scheduler");

export interface LoopStats {
  name: string; runs: number; errors: number; consecutiveErrors: number; lastOkAt: number | null; lastError: string | null; running: boolean;
  /** Iterations that exceeded the watchdog (the next tick was started without waiting for them). */
  overruns: number; lastDurationMs: number | null; intervalMs: number;
}

/** Unhealthy: ≥ 5 consecutive errors, or no successful iteration for max(10 × interval, 120 s) once started. */
export function loopHealthy(l: LoopStats, now = Date.now(), startedAt = 0): boolean {
  if (l.consecutiveErrors >= 5) return false;
  const staleMs = Math.max(10 * l.intervalMs, 120_000);
  const since = l.lastOkAt ?? startedAt;
  return !since || now - since < staleMs;
}

export const DEFAULT_WATCHDOG_MS = 30_000;

export interface LoopOpts {
  maxBackoffMs?: number;
  initialDelayMs?: number;
  /** If an iteration runs longer than this, log an error and schedule the next tick anyway (default 30 s). */
  watchdogMs?: number;
}

export class Scheduler {
  private loops = new Map<string, { stats: LoopStats; timer?: NodeJS.Timeout }>();
  private stopped = false;

  add(name: string, intervalMs: number, fn: () => Promise<void>, opts: LoopOpts = {}) {
    const stats: LoopStats = { name, runs: 0, errors: 0, consecutiveErrors: 0, lastOkAt: null, lastError: null, running: false, overruns: 0, lastDurationMs: null, intervalMs };
    const entry: { stats: LoopStats; timer?: NodeJS.Timeout } = { stats };
    this.loops.set(name, entry);
    const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    const tick = async () => {
      if (this.stopped) return;
      stats.running = true;
      const t0 = Date.now();
      let wd: NodeJS.Timeout | undefined;
      const run = (async () => {
        try {
          await fn();
          stats.runs++; stats.consecutiveErrors = 0; stats.lastOkAt = Date.now();
        } catch (e) {
          stats.errors++; stats.consecutiveErrors++; stats.lastError = (e as Error).message;
          log.error("loop error", { loop: name, err: e, consecutive: stats.consecutiveErrors });
        } finally {
          stats.lastDurationMs = Date.now() - t0;
          if (stats.lastDurationMs > watchdogMs) log.warn("loop iteration finished late", { loop: name, ms: stats.lastDurationMs });
        }
        return "done" as const;
      })();
      const overrun = new Promise<"overrun">((r) => { wd = setTimeout(() => r("overrun"), watchdogMs); });
      const outcome = await Promise.race([run, overrun]);
      clearTimeout(wd);
      if (outcome === "overrun") {
        stats.overruns++; stats.lastError = `iteration exceeded watchdog ${watchdogMs} ms`;
        log.error("loop watchdog: iteration exceeded limit, starting next tick", { loop: name, watchdogMs });
      } else stats.running = false;
      const backoff = stats.consecutiveErrors ? Math.min(intervalMs * 2 ** stats.consecutiveErrors, opts.maxBackoffMs ?? 60_000) : intervalMs;
      const delay = outcome === "overrun" ? 0 : Math.max(0, backoff - (Date.now() - t0));
      if (!this.stopped) entry.timer = setTimeout(tick, delay);
    };
    entry.timer = setTimeout(tick, opts.initialDelayMs ?? 0);
  }
  stats(): LoopStats[] { return [...this.loops.values()].map((l) => ({ ...l.stats })); }
  stop() { this.stopped = true; for (const l of this.loops.values()) clearTimeout(l.timer); }
}

/** Retry with exponential backoff for transient failures. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { tries?: number; baseMs?: number; retryable?: (e: unknown) => boolean } = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (opts.retryable && !opts.retryable(e)) throw e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, (opts.baseMs ?? 500) * 2 ** i));
    }
  }
  throw last;
}
