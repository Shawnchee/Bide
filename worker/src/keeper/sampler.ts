// Time-critical sample poster (integration run #2). Run #1 lost a whole quick sampling window because sampling
// lived inside the keeper tick, behind other RPC work that hung. Now sampling is its own 1 s loop with its own
// Connection; it never awaits a chain read during a tick (the view refreshes in the background) and posts each
// bucket at bucket_start + SAMPLE_POST_DELAY_SECS, concurrently, independent of the keeper.
import { PublicKey, type Keypair } from "@solana/web3.js";
import type { BideChain } from "../chain/client.js";
import { parseProgramError } from "../chain/errors.js";
import type { AssetState, EpochState, RoundState } from "../chain/types.js";
import { logger } from "../log.js";
import { FEED_IDS, getPriceUpdateAt } from "../pyth/hermes.js";
import { bucketStart, KIND_PARAMS, windowStart, type EpochKind } from "./schedule.js";

const log = logger("sampler");

/** Post a bucket this many seconds after its start (Hermes has the exact-second update by then). */
export const SAMPLE_POST_DELAY_SECS = 2;
/** Refresh the chain view this often while sampling is (about to be) active, and when idle. */
export const ACTIVE_REFRESH_MS = 4_000;
export const IDLE_REFRESH_MS = 20_000;
/** "Active" starts this long before the sampling window (so the view is fresh when bucket 0 is due). */
export const ACTIVE_LEAD_SECS = 60;
export const MAX_CONCURRENT_POSTS = 6;

export interface SampleView { now?: number; assets: AssetState[]; rounds: RoundState[]; epochs: EpochState[] }
export interface SampleTask { key: string; epoch: string; asset: string; feedId: string; kind: EpochKind; bucket: number; publishTime: number; expiry: number }

const sampled = (e: EpochState) => e.status === "Open" || e.status === "Sampling";
const liveEpochs = (v: SampleView) => {
  const live = new Set(v.rounds.filter((r) => r.status === "Live").map((r) => r.epoch));
  return v.epochs.filter((e) => sampled(e) && live.has(e.pubkey));
};

/** Is any epoch with a Live round within [window start − lead, expiry + grace]? Drives the refresh cadence. */
export function samplingActive(v: SampleView, now: number, lead = ACTIVE_LEAD_SECS): boolean {
  return liveEpochs(v).some((e) => now >= windowStart(e.kind, e.expiry) - lead && now <= e.expiry + KIND_PARAMS[e.kind].graceSecs);
}

/** Buckets to post now: Live-round epochs, bucket not yet in the mask, start + delay reached, still inside grace. Pure. */
export function dueSamples(v: SampleView, now: number, delay = SAMPLE_POST_DELAY_SECS): SampleTask[] {
  const out: SampleTask[] = [];
  const assets = new Map(v.assets.map((a) => [a.pubkey, a]));
  for (const e of liveEpochs(v)) {
    const p = KIND_PARAMS[e.kind];
    if (now > e.expiry + p.graceSecs) continue;
    const a = assets.get(e.asset);
    const feedId = a?.pythFeedId || FEED_IDS[a?.symbol ?? "SOL"];
    for (let i = 0; i < p.nBuckets; i++) {
      if (e.sampleMask & (1 << i)) continue;
      const t = bucketStart(e.kind, e.expiry, i);
      if (now < t + delay) break; // buckets are ordered in time
      out.push({ key: `${e.pubkey}:${i}`, epoch: e.pubkey, asset: e.asset, feedId, kind: e.kind, bucket: i, publishTime: t, expiry: e.expiry });
    }
  }
  return out;
}

export interface SamplerDeps {
  chain: BideChain;
  signer: Keypair;
  /** Hermes fetch (tests inject). */
  getUpdate?: typeof getPriceUpdateAt;
  /** ms clock (tests). */
  now?: () => number;
}

export class Sampler {
  private view: SampleView | null = null;
  private viewAt = 0;
  private refreshing: Promise<void> | null = null;
  private done = new Set<string>();
  private inflight = new Set<string>();
  private retryAt = new Map<string, { at: number; offset: number; fails: number }>();
  readonly posted: { key: string; sigs: string[]; ms: number }[] = [];
  constructor(private d: SamplerDeps) {}

  private nowMs() { return (this.d.now ?? Date.now)(); }

  private refresh(): Promise<void> {
    if (!this.refreshing) {
      const c = this.d.chain;
      const read = c.sampleView ? c.sampleView() : c.snapshot();
      this.refreshing = read.then((v) => { this.view = v; this.viewAt = this.nowMs(); this.prune(); })
        .catch((e) => log.warn("sample view refresh failed", { err: (e as Error).message.slice(0, 200) }))
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** One 1 s tick. Never blocks on RPC except the very first view load. Returns the tasks started (tests). */
  async tick(): Promise<string[]> {
    const nowMs = this.nowMs();
    const now = Math.floor(nowMs / 1000);
    if (!this.view) { await this.refresh(); if (!this.view) return []; }
    const active = samplingActive(this.view, now);
    if (nowMs - this.viewAt > (active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS)) void this.refresh();
    if (!active) return [];
    const started: string[] = [];
    for (const t of dueSamples(this.view, now)) {
      if (this.done.has(t.key) || this.inflight.has(t.key)) continue;
      const r = this.retryAt.get(t.key);
      if (r && nowMs < r.at) continue;
      if (this.inflight.size >= MAX_CONCURRENT_POSTS) break;
      this.inflight.add(t.key);
      started.push(t.key);
      void this.post(t, r?.offset ?? 0).finally(() => this.inflight.delete(t.key));
    }
    return started;
  }

  private async post(t: SampleTask, offset: number): Promise<void> {
    const t0 = this.nowMs();
    const tol = KIND_PARAMS[t.kind].bucketToleranceSecs;
    try {
      const upd = await (this.d.getUpdate ?? getPriceUpdateAt)(t.feedId, t.publishTime + offset);
      if (upd.parsed.publishTime < t.publishTime || upd.parsed.publishTime > t.publishTime + tol) {
        throw new Error(`hermes publish_time ${upd.parsed.publishTime} outside bucket [${t.publishTime}, +${tol}]`);
      }
      const sigs = await this.d.chain.postSample(this.d.signer, new PublicKey(t.epoch), t.bucket, upd.binary[0]!);
      const ms = this.nowMs() - t0;
      this.done.add(t.key);
      this.retryAt.delete(t.key);
      this.posted.push({ key: t.key, sigs, ms });
      log.info("post_sample", { epoch: t.epoch, bucket: t.bucket, publishTime: upd.parsed.publishTime, price: upd.parsed.price, lagS: Math.floor(this.nowMs() / 1000) - t.publishTime, ms, sigs });
    } catch (e) {
      const pe = parseProgramError(e);
      if (pe.name === "BucketFilled") { this.done.add(t.key); log.info("bucket already filled", { task: t.key }); return; }
      if (pe.name && ["SampleOutsideBucket", "BucketOutOfRange", "EpochNotOpen", "EpochFailed", "WrongFeed"].includes(pe.name)) {
        this.done.add(t.key);
        log.error("post_sample rejected, giving up on bucket", { task: t.key, err: pe.name, sig: (e as any)?.signature });
        return;
      }
      const prev = this.retryAt.get(t.key);
      const fails = (prev?.fails ?? 0) + 1;
      // Conf too wide at this second → try the next second(s) inside the bucket tolerance.
      const nextOffset = pe.name === "PriceConfidenceTooWide" ? Math.min(offset + 1, tol) : offset;
      this.retryAt.set(t.key, { at: this.nowMs() + Math.min(1_000 * fails, 5_000), offset: nextOffset, fails });
      log.warn("post_sample failed, will retry", { task: t.key, err: pe.name, msg: pe.message.slice(0, 200), fails, offset: nextOffset });
    }
  }

  /** Mark buckets of a now-resolved view as done (keeps memory bounded). */
  prune(): void {
    if (!this.view) return;
    const live = new Set(liveEpochs(this.view).map((e) => e.pubkey));
    for (const k of this.done) if (!live.has(k.split(":")[0]!)) this.done.delete(k);
  }
}
