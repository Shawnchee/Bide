/**
 * One serial queue for every GLM call in the worker (desk Quant, GLM risk fallback, maker stances, intake).
 * GLM-5.3 always thinks (seconds per call) and the Coding Plan quota is shared, so calls run one at a time.
 * Lower priority number runs first: the desk (0) is never stuck behind maker stances (2).
 */
import type { ChatRequest, ChatResponse, ChatTransport } from "../desk/llm/chat.js";

export const PRIORITY = { desk: 0, intake: 1, maker: 2 } as const;

interface Job { priority: number; seq: number; run: () => Promise<void> }

export class LlmQueue {
  private jobs: Job[] = [];
  private running = false;
  private seq = 0;
  readonly stats = { done: 0, failed: 0, maxWaitMs: 0, pending: 0, byPriority: {} as Record<number, number> };

  enqueue<T>(priority: number, fn: () => Promise<T>): Promise<T> {
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
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        this.jobs.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        this.stats.pending = this.jobs.length - 1;
        await this.jobs.shift()!.run();
      }
    } finally {
      this.stats.pending = 0;
      this.running = false;
    }
  }

  /** A ChatTransport whose calls go through this queue at `priority`. */
  wrap(inner: ChatTransport, priority: number): ChatTransport {
    return { provider: inner.provider, complete: (req: ChatRequest): Promise<ChatResponse> => this.enqueue(priority, () => inner.complete(req)) };
  }
}
