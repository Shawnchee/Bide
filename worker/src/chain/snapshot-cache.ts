// One chain read shared by keeper, makers, mirror and desk tools (avoids hammering RPC).
import type { BideChain } from "./client.js";
import type { ChainSnapshot } from "./types.js";

export class SnapshotCache {
  private last: ChainSnapshot | null = null;
  private at = 0;
  private inflight: Promise<ChainSnapshot> | null = null;
  constructor(private chain: BideChain | null, private ttlMs = 1500) {}
  setChain(c: BideChain | null) { this.chain = c; }
  async get(maxAgeMs = this.ttlMs): Promise<ChainSnapshot | null> {
    if (!this.chain) return null;
    if (this.last && Date.now() - this.at < maxAgeMs) return this.last;
    if (!this.inflight) {
      this.inflight = this.chain.snapshot().then((s) => { this.last = s; this.at = Date.now(); return s; }).finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }
  peek() { return this.last; }
  invalidate() { this.at = 0; }
}
