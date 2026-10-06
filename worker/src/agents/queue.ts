/**
 * One queue for every GLM call in the worker (keeper desk rounds, maker stances, desk previews, intake).
 * GLM-5.3 always thinks (seconds per call) and the Coding Plan quota is shared, so calls are bounded:
 *
 * - High lane (keeper desk = 0, maker stances = 1): serial, lower number first, FIFO within a priority.
 * - Low lane (public previews / intake = 2): at most `maxLowInFlight` (1) call at a time, and a low call only STARTS
 *   when no high-lane job is running or waiting. A high job never waits behind a running low call: with
 *   `highBypassesLow` (default) it starts alongside it, so at most 2 GLM calls run at once (1 high + 1 low).
 * - Low backlog is bounded (`maxLowPending`): beyond it `enqueue` rejects with QueueFullError (→ HTTP 429).
 *
 * Public, user-triggered work therefore can never delay a keeper round's desk run.
 */
import type { ChatRequest, ChatResponse, ChatTransport } from "../desk/llm/chat.js";

export const PRIORITY = { desk: 0, maker: 1, preview: 2, intake: 2 } as const;
/** Priorities >= this are the low (public) lane. */
export const LOW_LANE = 2;

export class QueueFullError extends Error {
  readonly status = 429;
  constructor(readonly retryAfterSecs: number) { super("the AI desk is busy, try again shortly"); }
}

export interface LlmQueueOptions {
  maxLowInFlight?: number;
  maxLowPending?: number;
  /** A high-lane job may start while a low-lane call is in flight (default true). */
  highBypassesLow?: boolean;
}

interface Job { priority: number; seq: number; run: () => Promise<void> }

export class LlmQueue {
  private jobs: Job[] = [];
  private highRunning = 0;
  private lowRunning = 0;
  private seq = 0;
  private readonly maxLowInFlight: number;
  private readonly maxLowPending: number;
  private readonly highBypassesLow: boolean;
  readonly stats = { done: 0, failed: 0, rejected: 0, maxWaitMs: 0, pending: 0, highRunning: 0, lowRunning: 0, byPriority: {} as Record<number, number> };

  constructor(o: LlmQueueOptions = {}) {
    this.maxLowInFlight = Math.max(1, o.maxLowInFlight ?? 1);
    this.maxLowPending = Math.max(0, o.maxLowPending ?? 8);
    this.highBypassesLow = o.highBypassesLow ?? true;
  }

  /** Low-lane jobs queued (not yet started). */
  lowPending(): number { return this.jobs.filter((j) => j.priority >= LOW_LANE).length; }
  highPending(): number { return this.jobs.filter((j) => j.priority < LOW_LANE).length; }

  enqueue<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    if (priority >= LOW_LANE && this.lowPending() >= this.maxLowPending) {
      this.stats.rejected++;
      return Promise.reject(new QueueFullError(30));
    }
    const queuedAt = Date.now();
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        priority,
        seq: this.seq++,
        run: async () => {
          this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, Date.now() - queuedAt);
          try { resolve(await fn()); this.stats.done++; } catch (e) { this.stats.failed++; reject(e); }
        },
      });
      this.stats.byPriority[priority] = (this.stats.byPriority[priority] ?? 0) + 1;
      this.pump();
    });
  }

  private start(job: Job, low: boolean) {
    this.jobs.splice(this.jobs.indexOf(job), 1);
    if (low) this.lowRunning++; else this.highRunning++;
    this.sync();
    void job.run().finally(() => {
      if (low) this.lowRunning--; else this.highRunning--;
      this.sync();
      this.pump();
    });
  }

  private sync() {
    this.stats.pending = this.jobs.length;
    this.stats.highRunning = this.highRunning;
    this.stats.lowRunning = this.lowRunning;
  }

  private pump() {
    this.jobs.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    // High lane: serial; may bypass a running low call.
    const high = this.jobs.find((j) => j.priority < LOW_LANE);
    if (high && this.highRunning === 0 && (this.highBypassesLow || this.lowRunning === 0)) this.start(high, false);
    // Low lane: only when the high lane is idle AND empty, and under the in-flight cap.
    const low = this.jobs.find((j) => j.priority >= LOW_LANE);
    if (low && this.highRunning === 0 && !this.jobs.some((j) => j.priority < LOW_LANE) && this.lowRunning < this.maxLowInFlight) this.start(low, true);
    this.sync();
  }

  /** A ChatTransport whose calls go through this queue at `priority`. */
  wrap(inner: ChatTransport, priority: number): ChatTransport {
    return { provider: inner.provider, complete: (req: ChatRequest): Promise<ChatResponse> => this.enqueue(priority, () => inner.complete(req)) };
  }
}

/**
 * Run-level gate for public low-priority work (a desk preview is several GLM calls + a Clef call): at most
 * `maxInFlight` runs at once and `maxWaiting` queued; `tryEnter` returns null when full (→ 429).
 * A slot is force-released after `holdTimeoutMs` so a hung run cannot wedge the lane.
 */
export class RunGate {
  private inFlight = 0;
  private waiting: (() => void)[] = [];
  constructor(private o: { maxInFlight: number; maxWaiting: number; holdTimeoutMs: number }) {}

  get load() { return { inFlight: this.inFlight, waiting: this.waiting.length }; }

  /** Admit a run or return null when the gate is full. The returned function runs `fn` when a slot frees. */
  tryEnter(): (<T>(fn: () => Promise<T>) => Promise<T>) | null {
    if (this.inFlight + this.waiting.length >= this.o.maxInFlight + this.o.maxWaiting) return null;
    let admitted: Promise<void>;
    if (this.inFlight < this.o.maxInFlight) { this.inFlight++; admitted = Promise.resolve(); }
    else admitted = new Promise<void>((r) => this.waiting.push(() => { this.inFlight++; r(); }));
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      await admitted;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.inFlight--;
        this.waiting.shift()?.();
      };
      const t = setTimeout(release, this.o.holdTimeoutMs);
      (t as { unref?: () => void }).unref?.();
      try { return await fn(); } finally { clearTimeout(t); release(); }
    };
  }
}
