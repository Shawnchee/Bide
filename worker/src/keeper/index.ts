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
}

/** Off-chain failures that must NOT be counted as on-chain rejections. */
export const OFFCHAIN_ERRORS = new Set(["EpochNotFound", "WindowMissed"]);

export class Keeper {
  private backoff = new Map<string, { until: number; fails: number }>();
  private deskDone = new Set<string>(); // plan:windowKey — run the desk once per auction window per plan
  private deskInflight = new Set<string>();
  private inflight = new Set<string>();
  private P;
  constructor(private d: KeeperDeps) { this.P = pdas(d.chain.programId); }

  async tick(): Promise<void> {
    const s = await this.d.snapshots.get();
    if (!s) return;
    const actions = planKeeperActions(s, s.now, {
      quickEnabled: this.d.quickEnabled,
      epochKey: (a, k, e) => this.P.epoch(new PublicKey(a), k, e).toBase58(),
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
        const pe = parseProgramError(e);
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
      case "pool_take_round": return this.sig(a.round, "pool_take", await chain.poolTakeRound(signer, pk(a.round)));
      case "cancel_round": {
        log.info("cancel_round", { round: a.round, reason: a.reason });
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
    let r = await desk.runDesk({ plan_id: p.pubkey, kind: "round" }, { onStep });
    await this.recordRun(runId, r);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (r.final.status === "flip") {
        const sig = await this.d.chain.flipPlan(this.d.signer, new PublicKey(p.pubkey));
        await repo.updateDeskRun(runId, { tx_sig: sig, status: "flipped" });
        return;
      }
      if (r.final.status !== "open" || !r.final.proposal) return; // skip / stop / vetoed / error → no tx this cycle
      const outcome = await this.submitOpenRound(p, r);
      if (outcome.ok) { await repo.updateDeskRun(runId, { tx_sig: outcome.sig, status: "submitted" }); return; }
      if (outcome.transient) { await repo.updateDeskRun(runId, { status: "submit_failed", error_code: "Transient" }); return; }
      // Rejected (on-chain) or EpochNotFound (off-chain): record, then exactly one desk retry.
      await repo.updateDeskRun(runId, { status: outcome.offchain ? "offchain_error" : "rejected", error_code: outcome.code, tx_sig: outcome.sig ?? null });
      if (attempt === 1 || outcome.code === "WindowMissed") return; // no point retrying once the window is gone
      const retryId = await repo.createDeskRun({ plan_pubkey: p.pubkey, kind: "round", status: "running" });
      r = await desk.retryWithChainError(r, outcome.code, { onStep: (st) => repo.appendDeskStep(retryId, st) });
      await this.recordRun(retryId, r);
      return this.submitRetry(p, r, retryId);
    }
  }

  private async submitRetry(p: PlanState, r: DeskResult, runId: string) {
    if (r.final.status !== "open" || !r.final.proposal) return;
    const o = await this.submitOpenRound(p, r);
    await this.d.repo.updateDeskRun(runId, o.ok ? { tx_sig: o.sig, status: "submitted" } : { status: o.offchain ? "offchain_error" : o.transient ? "submit_failed" : "rejected", error_code: o.code, tx_sig: o.sig ?? null });
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
    const s = await this.d.snapshots.get(0);
    const epochPk = this.P.epoch(new PublicKey(p.asset), kind, prop.expiry ?? 0).toBase58();
    if (!s?.epochs.some((e) => e.pubkey === epochPk)) {
      log.warn("desk proposal targets a missing epoch", { plan: p.pubkey, expiry: prop.expiry, kind });
      return { ok: false, code: "EpochNotFound", offchain: true };
    }
    try {
      const sig = await this.d.chain.openRound(this.d.signer, new PublicKey(p.pubkey), {
        roundIndex: (s.plans.find((x) => x.pubkey === p.pubkey)?.roundCount ?? p.roundCount),
        strike: BigInt(prop.strike!), size: BigInt(prop.size!), auctionSecs: prop.auction_secs!,
        premiumStart: BigInt(prop.premium_start!), premiumFloor: BigInt(prop.premium_floor!), memoHash: r.memo_hash, epoch: new PublicKey(epochPk),
      });
      log.info("open_round", { plan: p.pubkey, sig, memo: r.memo_hash_hex });
      this.d.snapshots.invalidate();
      return { ok: true, sig };
    } catch (e) {
      const pe = parseProgramError(e);
      const sig = (e as any)?.signature as string | undefined; // set when the tx landed and failed on-chain
      if (pe.name || pe.code !== undefined) {
        log.warn("open_round rejected on-chain", { plan: p.pubkey, err: pe.name, code: pe.code });
        return { ok: false, code: pe.name ?? String(pe.code), sig };
      }
      log.warn("open_round failed (not a program error)", { plan: p.pubkey, msg: pe.message.slice(0, 300) });
      return { ok: false, code: "Transient", transient: true };
    }
  }
}

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
