// Keeper executor (BUILD §4.3): reads a snapshot, plans actions (keeper/plan.ts), executes each with
// per-action error isolation and backoff. Desk proposals are submitted AS-IS (no pre-filtering).
import { PublicKey, type Keypair } from "@solana/web3.js";
import { parseProgramError } from "../chain/errors.js";
import type { BideChain } from "../chain/client.js";
import { pdas } from "../chain/pdas.js";
import type { SnapshotCache } from "../chain/snapshot-cache.js";
import type { ChainSnapshot, PlanState } from "../chain/types.js";
import type { Repo } from "../db/types.js";
import type { Desk, DeskResult } from "../desk/index.js";
import { logger } from "../log.js";
import { FEED_IDS, getPriceUpdateAt } from "../pyth/hermes.js";
import { KIND_PARAMS, DEFAULT_AUCTION_SECS, canOpenRound, stdWindowOpen, type EpochKind } from "./schedule.js";
import { planKeeperActions, quickTargetExpiry, type KeeperAction } from "./plan.js";
import { publicCancelAt } from "../chain/auction.js";

/** Leave this much of max_spot_age_secs for a pool take to land (same margin as the maker bots). */
export const POOL_SPOT_AGE_MARGIN_SECS = 15;
/** pool_take_round errors a later feed update / tick can clear: keep retrying until the pool deadline. */
const POOL_RETRY_ERRORS = new Set(["StalePrice", "PriceConfidenceTooWide", "SpotMovedTooMuch"]);
/** Thrown by exec when an action must wait (no tx sent, no backoff). */
class Hold extends Error {}

const log = logger("keeper");

export interface KeeperDeps {
  chain: BideChain;
  snapshots: SnapshotCache;
  signer: Keypair; // KEEPER_KEYPAIR = Config.agent
  repo: Repo;
  desk: Desk | null;
  quickEnabled: boolean;
  /** True when the dedicated Sampler loop posts samples (keeper then skips post_sample). */
  skipSampling?: boolean;
  onRoundSig?: (round: string, label: string, sig: string) => void;
  /** ms clock (tests). */
  now?: () => number;
  /** sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Off-chain failures that must NOT be counted as on-chain rejections. */
export const OFFCHAIN_ERRORS = new Set(["EpochNotFound", "WindowMissed"]);

export class Keeper {
  private backoff = new Map<string, { until: number; fails: number }>();
  private deskDone = new Set<string>(); // plan:windowKey — run the desk once per auction window per plan
  private deskInflight = new Set<string>();
  /**
   * Keeper desk runs are serialized: the GLM high lane is FIFO per call, so two concurrent runs interleave call by call
   * and BOTH finish ~2× late (stress test 6 Oct 12:01: buy run done E−538, sell run E−498 → WindowMissed). One at a
   * time, the first plan always makes the window and the second still has the rest of the lead + window.
   */
  private deskLane: Promise<unknown> = Promise.resolve();
  private serialDesk<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.deskLane.then(fn, fn);
    // A hung run must not wedge every later plan: the lane frees after DESK_LANE_HOLD_MS even if `run` is still going.
    let t: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((r) => { t = setTimeout(r, DESK_LANE_HOLD_MS); (t as { unref?: () => void }).unref?.(); });
    this.deskLane = Promise.race([run.then(() => {}, () => {}), cap]).finally(() => clearTimeout(t));
    return run;
  }
  private inflight = new Set<string>();
  private poolGaveUp = new Set<string>();
  private holdLoggedAt = new Map<string, number>();
  private P;
  constructor(private d: KeeperDeps) { this.P = pdas(d.chain.programId); }

  async tick(): Promise<void> {
    const s = await this.d.snapshots.get();
    if (!s) return;
    const actions = planKeeperActions(s, s.now, {
      quickEnabled: this.d.quickEnabled,
      epochKey: (a, k, e) => this.P.epoch(new PublicKey(a), k, e).toBase58(),
      poolGaveUp: this.poolGaveUp,
    });
    let changed = false;
    for (const a of actions) {
      if (a.type === "post_sample" && this.d.skipSampling) continue;
      const key = actionKey(a);
      if (this.inflight.has(key)) continue; // still running from an iteration the watchdog gave up on
      const b = this.backoff.get(key);
      if (b && Date.now() < b.until) continue;
      if (a.type === "desk_open_round" || a.type === "desk_flip") { this.startDesk(a.plan, s); continue; } // async, long-running
      this.inflight.add(key);
      try {
        await this.exec(a, s);
        this.backoff.delete(key);
        changed = true;
      } catch (e) {
        if (e instanceof Hold) continue; // waiting (e.g. stale push feed): retry next tick, no backoff
        const pe = parseProgramError(e);
        if (a.type === "pool_take_round" && !(pe.retryable || (pe.name && POOL_RETRY_ERRORS.has(pe.name)))) this.poolGaveUp.add(a.round);
        const fails = (b?.fails ?? 0) + 1;
        const wait = Math.min(2_000 * 2 ** fails, 120_000);
        this.backoff.set(key, { until: Date.now() + wait, fails });
        log.warn("action failed", { action: a, errName: pe.name, errCode: pe.code, msg: pe.message.slice(0, 300), retryInMs: wait });
      } finally { this.inflight.delete(key); }
    }
    if (changed) this.d.snapshots.invalidate();
  }

  private async exec(a: KeeperAction, s: ChainSnapshot) {
    const { chain, signer } = this.d;
    const pk = (x: string) => new PublicKey(x);
    switch (a.type) {
      case "open_epoch": {
        const sig = await chain.openEpoch(signer, pk(a.asset), a.kind, a.expiry);
        log.info("open_epoch", { kind: a.kind, expiry: new Date(a.expiry * 1000).toISOString(), sig });
        return;
      }
      case "pool_take_round": {
        // pool_take_round reads the push feed like take_round (StalePrice past max_spot_age_secs). Hold — no failed tx —
        // until it is fresh; the planner cancels once the pool's deadline (pool_open + 60 s) is near.
        const r = s.rounds.find((x) => x.pubkey === a.round);
        const asset = r && s.assets.find((x) => x.pubkey === r.asset);
        if (r && asset && chain.spotAgeSecs) {
          const age = await chain.spotAgeSecs(pk(r.asset)).catch(() => 0);
          if (age > asset.maxSpotAgeSecs - POOL_SPOT_AGE_MARGIN_SECS) {
            const last = this.holdLoggedAt.get(a.round) ?? 0;
            if (Date.now() - last >= 10_000) {
              this.holdLoggedAt.set(a.round, Date.now());
              log.info("push feed stale, holding pool take", { round: a.round, ageSecs: age, max: asset.maxSpotAgeSecs, secsToPoolDeadline: publicCancelAt(r) - s.now });
            }
            throw new Hold();
          }
        }
        return this.sig(a.round, "pool_take", await chain.poolTakeRound(signer, pk(a.round)));
      }
      case "cancel_round": {
        const r = s.rounds.find((x) => x.pubkey === a.round);
        const age = r && chain.spotAgeSecs ? await chain.spotAgeSecs(pk(r.asset)).catch(() => null) : null;
        log.info("cancel_round", { round: a.round, reason: a.reason, feedAgeSecs: age });
        return this.sig(a.round, "cancel", await chain.cancelRound(signer, pk(a.round)));
      }
      case "post_sample": {
        const asset = s.assets.find((x) => x.pubkey === a.asset)!;
        const ep = s.epochs.find((e) => e.pubkey === a.epoch)!;
        const tol = KIND_PARAMS[ep.kind as EpochKind].bucketToleranceSecs;
        const upd = await getPriceUpdateAt(asset.pythFeedId || FEED_IDS[asset.symbol], a.publishTime);
        if (upd.parsed.publishTime < a.publishTime || upd.parsed.publishTime > a.publishTime + tol) {
          throw new Error(`hermes publish_time ${upd.parsed.publishTime} outside bucket [${a.publishTime}, +${tol}]`);
        }
        const sigs = await chain.postSample(signer, pk(a.epoch), a.bucket, upd.binary[0]!);
        log.info("post_sample", { epoch: a.epoch, bucket: a.bucket, price: upd.parsed.price, sigs });
        return;
      }
      case "resolve_epoch": {
        const sig = await chain.resolveEpoch(signer, pk(a.epoch));
        log.info("resolve_epoch", { epoch: a.epoch, expect: a.expect, sig });
        return;
      }
      case "resolve_round": return this.sig(a.round, "resolve", await chain.resolveRound(signer, pk(a.round)));
      case "withdraw_collateral": return this.sig(a.round, "withdraw", await chain.withdrawCollateral(signer, pk(a.round)));
      case "unwind_round": return this.sig(a.round, "unwind", await chain.unwindRound(signer, pk(a.round)));
      case "expire_plan": { log.info("expire_plan", { plan: a.plan, sig: await chain.expirePlan(signer, pk(a.plan)) }); return; }
      default: return;
    }
  }

  private async sig(round: string, label: string, sig: string) {
    log.info(label, { round, sig });
    this.d.onRoundSig?.(round, label, sig);
    await this.d.repo.addRoundSig(round, label, sig).catch(() => {});
  }

  // ---------------- desk → open_round ----------------
  private windowKey(p: PlanState, now: number) {
    return p.quick ? `${p.pubkey}:q:${quickTargetExpiry(now)}` : `${p.pubkey}:s:${Math.floor((now - 28_800) / 86_400)}`;
  }

  private startDesk(planPk: string, s: ChainSnapshot) {
    const p = s.plans.find((x) => x.pubkey === planPk);
    if (!p || !this.d.desk) return;
    const wk = this.windowKey(p, s.now);
    if (this.deskDone.has(wk) || this.deskInflight.has(planPk)) return;
    this.deskInflight.add(planPk);
    this.deskDone.add(wk);
    this.runDeskForPlan(p).catch((e) => log.error("desk run failed", { plan: planPk, err: e })).finally(() => this.deskInflight.delete(planPk));
  }

  async runDeskForPlan(p: PlanState): Promise<void> {
    const desk = this.d.desk!;
    const repo = this.d.repo;
    const runId = await repo.createDeskRun({ plan_pubkey: p.pubkey, kind: "round", status: "running" });
    const onStep = (st: unknown) => repo.appendDeskStep(runId, st);
    let r = await this.serialDesk(() => desk.runDesk({ plan_id: p.pubkey, kind: "round" }, { onStep }));
    await this.recordRun(runId, r);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (r.final.status === "flip") {
        const sig = await this.d.chain.flipPlan(this.d.signer, new PublicKey(p.pubkey));
        await repo.updateDeskRun(runId, { tx_sig: sig, status: "flipped" });
        return;
      }
      if (r.final.status !== "open" || !r.final.proposal) return; // skip / stop / vetoed / error → no tx this cycle
      const outcome = await this.submitOpenRound(p, r);
      if (outcome.ok) { await repo.updateDeskRun(runId, { tx_sig: outcome.sig || null, status: "submitted" }); return; }
      if (outcome.transient) { await repo.updateDeskRun(runId, { status: "submit_failed", error_code: "Transient" }); return; }
      // Rejected (on-chain) or EpochNotFound (off-chain): record, then exactly one desk retry.
      await repo.updateDeskRun(runId, { status: outcome.offchain ? "offchain_error" : "rejected", error_code: outcome.code, tx_sig: outcome.sig ?? null });
      if (attempt === 1 || outcome.code === "WindowMissed") return; // no point retrying once the window is gone
      const retryId = await repo.createDeskRun({ plan_pubkey: p.pubkey, kind: "round", status: "running" });
      const prev = r;
      r = await this.serialDesk(() => desk.retryWithChainError(prev, outcome.code, { onStep: (st) => repo.appendDeskStep(retryId, st) }));
      await this.recordRun(retryId, r);
      return this.submitRetry(p, r, retryId);
    }
  }

  private async submitRetry(p: PlanState, r: DeskResult, runId: string) {
    if (r.final.status !== "open" || !r.final.proposal) return;
    const o = await this.submitOpenRound(p, r);
    await this.d.repo.updateDeskRun(runId, o.ok ? { tx_sig: o.sig || null, status: "submitted" } : { status: o.offchain ? "offchain_error" : o.transient ? "submit_failed" : "rejected", error_code: o.code, tx_sig: o.sig ?? null });
  }

  private waitForWindow(kind: EpochKind, expiry: number) {
    return waitForWindowImpl(kind, expiry, DEFAULT_AUCTION_SECS[kind], this.d.now ?? Date.now, (ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async recordRun(id: string, r: DeskResult) {
    // Also log the run (memo hash, final, Clef answers): with the in-process repo the log is the only durable record.
    log.info("desk run", {
      id, status: r.final.status, memo_hash: r.memo_hash_hex, final: r.final, clef: r.memo.clef_answers, model_ids: r.memo.model_ids,
      steps: r.steps.length, memo_json: r.memo_json.length <= 20_000 ? r.memo_json : `${r.memo_json.slice(0, 20_000)}…`,
    });
    await this.d.repo.updateDeskRun(id, {
      steps: r.steps, proposal: r.memo.quant_proposal, verdict: r.memo.clef_answers, final: r.final, memo: JSON.parse(r.memo_json),
      memo_hash: r.memo_hash_hex, status: r.final.status, card: r.card,
    });
  }

  private async submitOpenRound(p: PlanState, r: DeskResult): Promise<{ ok: true; sig: string } | { ok: false; code: string; offchain?: boolean; transient?: boolean; sig?: string }> {
    const prop = r.final.proposal!;
    const kind: EpochKind = p.quick ? "Quick" : "Std";
    // Epoch lookup is by (asset, plan kind, proposed expiry). Missing → off-chain EpochNotFound, never an on-chain rejection.
    // Hold until the auction window opens (quick desk runs start early); never submit after it closes —
    // that would be a latency failure, not the program judging the agent.
    const w = await this.waitForWindow(kind, prop.expiry ?? 0);
    if (!w.ok) { log.warn("auction window missed", { plan: p.pubkey, expiry: prop.expiry, reason: w.reason }); return { ok: false, code: "WindowMissed", offchain: true }; }
    // Chained quick run (desk started while the previous round was still Live): wait until resolve_round has freed the plan.
    if (p.activeRound || p.pendingSettlement) {
      const idle = await this.waitPlanIdle(p.pubkey, kind, prop.expiry ?? 0);
      if (!idle.ok) { log.warn("plan not idle in time", { plan: p.pubkey, expiry: prop.expiry, reason: idle.reason }); return { ok: false, code: idle.reason === "window" ? "WindowMissed" : "PlanBusy", offchain: true }; }
    }
    const s = await this.d.snapshots.get(0);
    const epochPk = this.P.epoch(new PublicKey(p.asset), kind, prop.expiry ?? 0).toBase58();
    if (!s?.epochs.some((e) => e.pubkey === epochPk)) {
      log.warn("desk proposal targets a missing epoch", { plan: p.pubkey, expiry: prop.expiry, kind });
      return { ok: false, code: "EpochNotFound", offchain: true };
    }
    const startPlan = s.plans.find((x) => x.pubkey === p.pubkey) ?? p;
    const roundIndex = startPlan.roundCount;
    const hadActive = startPlan.activeRound;
    let lastSig: string | undefined; // signature of a send that timed out (may still have landed)
    let lastMsg = "";
    for (let attempt = 0; attempt < MAX_OPEN_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Transient failure (blockhash expiry, RPC timeout, network): retry the SAME desk result/memo while the
        // auction window is still open. Never double-open: re-read the chain first — a "timed out" tx may have landed.
        await this.sleep(OPEN_RETRY_DELAY_MS * attempt);
        const fresh = await this.d.snapshots.get(0).catch(() => null);
        const fp = fresh?.plans.find((x) => x.pubkey === p.pubkey);
        if (fp && (fp.roundCount !== roundIndex || (fp.activeRound && fp.activeRound !== hadActive))) {
          log.info("open_round landed despite send error", { plan: p.pubkey, sig: lastSig, roundCount: fp.roundCount });
          this.d.snapshots.invalidate();
          return { ok: true, sig: lastSig ?? "" };
        }
        const again = await this.waitForWindow(kind, prop.expiry ?? 0);
        if (!again.ok) {
          log.warn("auction window closed while retrying open_round", { plan: p.pubkey, attempts: attempt, lastErr: lastMsg.slice(0, 200) });
          return { ok: false, code: "WindowMissed", offchain: true };
        }
        if (!fp) { lastMsg = "could not re-read plan before retry"; continue; } // can't verify → don't send blind
      }
      try {
        const sig = await this.d.chain.openRound(this.d.signer, new PublicKey(p.pubkey), {
          roundIndex,
          strike: BigInt(prop.strike!), size: BigInt(prop.size!), auctionSecs: prop.auction_secs!,
          premiumStart: BigInt(prop.premium_start!), premiumFloor: BigInt(prop.premium_floor!), memoHash: r.memo_hash, epoch: new PublicKey(epochPk),
        });
        log.info("open_round", { plan: p.pubkey, sig, memo: r.memo_hash_hex, attempt });
        this.d.snapshots.invalidate();
        return { ok: true, sig };
      } catch (e) {
        const pe = parseProgramError(e);
        const sig = (e as any)?.signature as string | undefined; // set when the tx was sent (landed+failed, or expired)
        if (pe.name || pe.code !== undefined) {
          log.warn("open_round rejected on-chain", { plan: p.pubkey, err: pe.name, code: pe.code, sig });
          return { ok: false, code: pe.name ?? String(pe.code), sig };
        }
        if (sig) lastSig = sig;
        lastMsg = pe.message;
        log.warn("open_round failed (not a program error)", { plan: p.pubkey, attempt, err: pe.message.slice(0, 300), sig });
      }
    }
    // Final check: the last attempt may have landed despite the error.
    const fin = await this.d.snapshots.get(0).catch(() => null);
    const fp = fin?.plans.find((x) => x.pubkey === p.pubkey);
    if (fp && (fp.roundCount !== roundIndex || (fp.activeRound && fp.activeRound !== hadActive))) {
      this.d.snapshots.invalidate();
      return { ok: true, sig: lastSig ?? "" };
    }
    return { ok: false, code: "Transient", transient: true };
  }

  /** Poll the chain until the plan has no active round / pending settlement, while the auction window is open. */
  private async waitPlanIdle(planPk: string, kind: EpochKind, expiry: number): Promise<{ ok: boolean; reason?: "window" | "plan" }> {
    for (;;) {
      this.d.snapshots.invalidate();
      const s = await this.d.snapshots.get(0).catch(() => null);
      const fp = s?.plans.find((x) => x.pubkey === planPk);
      if (fp && (fp.status !== "Active" || fp.paused || fp.sizeFilled >= fp.sizeTotal)) return { ok: false, reason: "plan" };
      if (fp && !fp.activeRound && !fp.pendingSettlement) { log.info("plan idle, submitting chained desk result", { plan: planPk }); return { ok: true }; }
      const nowS = Math.floor((this.d.now ?? Date.now)() / 1000);
      if (!canOpenRound(kind, expiry, nowS + 3, DEFAULT_AUCTION_SECS[kind]).ok) return { ok: false, reason: "window" };
      await this.sleep(2_000);
    }
  }

  private sleep(ms: number) { return (this.d.sleep ?? ((x: number) => new Promise<void>((r) => setTimeout(r, x))))(ms); }
}

/** Max time one keeper desk run holds the serial desk lane (runs normally take 50–100 s). */
export const DESK_LANE_HOLD_MS = 150_000;

/** open_round sends per desk result: 1 + up to 3 retries on transient (non-program) failures. */
export const MAX_OPEN_ATTEMPTS = 4;
const OPEN_RETRY_DELAY_MS = 2_000;

/**
 * Latency guard only. Quick: wait for [expiry − 600, expiry − 540]; past it → WindowMissed.
 * Std: only "the 08:00–08:30 window has closed" is off-chain; every other rule (12 h, sampling overlap,
 * expiry bounds) is the desk's choice and goes to the program as-is.
 */
export async function waitForWindowImpl(kind: EpochKind, expiry: number, auctionSecs: number, nowFn: () => number, sleep: (ms: number) => Promise<void>): Promise<{ ok: boolean; reason?: string }> {
  for (;;) {
    const now = Math.floor(nowFn() / 1000);
    if (kind === "Std") return stdWindowOpen(now) ? { ok: true } : { ok: false, reason: "std auction window closed before the desk finished" };
    if (now < expiry - 600) { await sleep(Math.min((expiry - 600 - now) * 1000, 5_000)); continue; }
    return canOpenRound(kind, expiry, now, auctionSecs);
  }
}

function actionKey(a: KeeperAction): string {
  switch (a.type) {
    case "open_epoch": return `oe:${a.asset}:${a.kind}:${a.expiry}`;
    case "post_sample": return `ps:${a.epoch}:${a.bucket}`;
    case "resolve_epoch": return `re:${a.epoch}`;
    case "expire_plan": case "desk_flip": case "desk_open_round": return `${a.type}:${a.plan}`;
    default: return `${a.type}:${a.round}`;
  }
}
