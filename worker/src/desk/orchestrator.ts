/**
 * Desk orchestrator: tools → Quant → Risk → (one adjust retry) → final → memo hash → card.
 *
 * Binding rules (BUILD §5):
 *   - Risk argmax = veto   → status "vetoed" (no open_round this cycle).
 *   - Risk argmax = adjust → Quant gets ONE retry with the top concern; Risk judges the retry;
 *                            veto → "vetoed", otherwise the retry is final (no second retry).
 *   - Risk unavailable     → status "error" (fail closed: no open_round without a risk check).
 * The desk never checks or clamps plan bounds — the keeper submits `final.proposal` as-is.
 */
import type { ChatMessage, ChatTransport } from "./llm/chat.js";
import { createZaiTransport } from "./llm/chat.js";
import type { DeskFinal, DeskInput, DeskMemo, DeskResult, DeskStep, DeskTools, QuantProposal, RiskResult } from "./types.js";
import { Toolbox, roundKindOf } from "./tools.js";
import { QUANT_SYSTEM_PROMPT, chainRetryMessage, quantUserMessage, riskAdjustMessage, runQuant } from "./quant.js";
import { buildRiskState } from "./risk/state.js";
import { bindRisk } from "./risk/binding.js";
import { createRiskJudge, type RiskJudge } from "./risk/judge.js";
import { memoHash, normalizeForMemo } from "./canonical.js";
import { renderCard } from "./card.js";
import { DeskError, errorMessage } from "./errors.js";
import { readDeskConfig, type DeskConfig } from "./config.js";
import { groundedNumbers, thesisNumbers } from "../agents/grounding.js";

export interface DeskDeps {
  tools: DeskTools;
  transport: ChatTransport;
  risk: RiskJudge;
  quantModel: string;
  maxToolRounds?: number;
  now?: () => number; // unix ms
}

export interface RunOptions {
  /** Called for every progress step (stream into desk_runs.steps). Errors thrown here are ignored. */
  onStep?: (step: DeskStep) => void | Promise<void>;
}

export interface Desk {
  runDesk(input: DeskInput, opts?: RunOptions): Promise<DeskResult>;
  /** The keeper's single retry after an on-chain rejection of `prev.final.proposal`. */
  retryWithChainError(prev: DeskResult, errorCode: string, opts?: RunOptions): Promise<DeskResult>;
}

export function createDesk(deps: DeskDeps): Desk {
  const now = deps.now ?? Date.now;
  const maxToolRounds = deps.maxToolRounds ?? 8;

  async function runDesk(input: DeskInput, opts: RunOptions = {}): Promise<DeskResult> {
    const steps: DeskStep[] = [];
    const emit = async (step: DeskStep["step"], detail: Record<string, unknown> = {}) => {
      const s: DeskStep = { step, at: now(), detail };
      steps.push(s);
      try {
        await opts.onStep?.(s);
      } catch {
        /* progress sink errors never break a run */
      }
    };
    const startedAt = now();
    const toolbox = new Toolbox({ tools: deps.tools, planId: input.plan_id, now });
    const quantLog: DeskMemo["quant_proposal"] = [];
    const riskLog: DeskMemo["clef_answers"] = [];
    let quantModel = deps.quantModel;
    let final: DeskFinal;

    await emit("start", { plan_id: input.plan_id, kind: input.kind, chain_retry: input.chain_retry?.error_code ?? null });

    const quantOpts = {
      transport: deps.transport,
      model: deps.quantModel,
      toolbox,
      maxToolRounds,
      onToolCall: (name: string, ok: boolean) => void emit("tool_call", { name, ok, attempt: toolbox.attempt }),
      onRepair: (error: string) => void emit("quant_repair", { error }),
    };

    const judge = async (proposal: QuantProposal, attempt: number) => {
      const plan = toolbox.plan ?? (await ensurePlan(toolbox));
      await emit("risk_start", { attempt, order: deps.risk.order });
      const state = buildRiskState({
        proposal,
        traces: toolbox.traces,
        asset: plan.asset,
        asset_decimals: plan.asset_decimals,
        round_kind: roundKindOf(plan),
        patience: input.patience ?? null,
        now_ms: now(),
      });
      const r: RiskResult = await deps.risk.judge(state);
      const binding = bindRisk(r.answers);
      riskLog.push({ attempt, backend: r.backend, model: r.model, answers: r.answers, binding, fallbacks: r.fallbacks });
      for (const f of r.fallbacks) await emit("risk_fallback", { backend: f.backend, error: f.error });
      await emit("risk_result", { attempt, backend: r.backend, verdict: binding.verdict, p: r.answers.verdict, top_concern: binding.top_concern?.text ?? null });
      return binding;
    };

    try {
      // ---- Quant, attempt 0 ----
      await emit("quant_start", { attempt: 0 });
      const messages: ChatMessage[] = [
        { role: "system", content: QUANT_SYSTEM_PROMPT },
        { role: "user", content: quantUserMessage({ plan_id: input.plan_id, now_ms: now(), kind: input.kind }) },
      ];
      if (input.chain_retry) messages.push({ role: "user", content: chainRetryMessage(input.chain_retry.error_code, input.chain_retry.previous_proposal) });
      const q0 = await runQuant(messages, quantOpts);
      quantModel = q0.model;
      quantLog.push({ attempt: 0, trigger: input.chain_retry ? "chain_error" : "initial", proposal: q0.proposal });
      await emit("quant_proposal", { attempt: 0, proposal: q0.proposal });

      if (q0.proposal.action !== "open") {
        final = { status: q0.proposal.action, proposal: q0.proposal, reason: "quant chose " + q0.proposal.action };
      } else {
        const b0 = await judge(q0.proposal, 0);
        if (b0.verdict === "approve") final = { status: "open", proposal: q0.proposal, reason: "risk approved" };
        else if (b0.verdict === "veto") final = { status: "vetoed", proposal: q0.proposal, reason: "risk vetoed: " + (b0.top_concern?.text ?? "") };
        else {
          // ---- adjust → one Quant retry with the top concern ----
          const concern = b0.top_concern?.text ?? "Risk asked for an adjustment without a single clear concern; re-check the numbers.";
          await emit("quant_retry", { attempt: 1, concern });
          toolbox.attempt = 1;
          const q1 = await runQuant([...q0.messages, { role: "user", content: riskAdjustMessage(concern) }], quantOpts);
          quantLog.push({ attempt: 1, trigger: "risk_adjust", proposal: q1.proposal });
          await emit("quant_proposal", { attempt: 1, proposal: q1.proposal });
          if (q1.proposal.action !== "open") final = { status: q1.proposal.action, proposal: q1.proposal, reason: `after risk adjust, quant chose ${q1.proposal.action}` };
          else {
            const b1 = await judge(q1.proposal, 1);
            final =
              b1.verdict === "veto"
                ? { status: "vetoed", proposal: q1.proposal, reason: "risk vetoed the adjusted proposal: " + (b1.top_concern?.text ?? "") }
                : { status: "open", proposal: q1.proposal, reason: `adjusted after risk (${b1.verdict} on retry; no second retry)` };
          }
        }
      }
    } catch (e) {
      const msg = errorMessage(e);
      const lastProposal = quantLog.length ? quantLog[quantLog.length - 1]!.proposal : null;
      if (!quantLog.length || (e instanceof DeskError && e.code.startsWith("QUANT"))) quantLog.push({ attempt: toolbox.attempt, trigger: toolbox.attempt ? "risk_adjust" : input.chain_retry ? "chain_error" : "initial", proposal: null, error: msg });
      final = { status: "error", proposal: lastProposal, reason: msg };
      await emit("error", { code: e instanceof DeskError ? e.code : "UNKNOWN", message: msg });
    }

    await emit("final", { status: final.status, reason: final.reason });

    let plan = toolbox.plan;
    if (!plan) {
      try {
        plan = await ensurePlan(toolbox);
      } catch {
        plan = null;
      }
    }

    const memoRaw: DeskMemo = {
      inputs: { plan_id: input.plan_id, kind: input.kind, patience: input.patience ?? null, chain_retry: input.chain_retry ?? null },
      quant_proposal: quantLog,
      clef_answers: riskLog,
      final,
      tool_traces: toolbox.traces,
      model_ids: { quant: quantModel, risk: [...new Set(riskLog.map((r) => `${r.backend}:${r.model}`))] },
      timestamps: { started_at: startedAt, finished_at: now() },
      provenance: final.proposal && final.proposal.action === "open" ? provenance(final.proposal, toolbox.traces) : {},
      outcomes_cited: final.proposal ? citesRecentOutcomes(final.proposal.rationale, toolbox.traces) : null,
    };
    const memo = normalizeForMemo(memoRaw);
    const h = memoHash(memo);
    await emit("memo", { memo_hash: h.hex });

    const card = renderCard({ final, plan, traces: toolbox.traces, now_ms: now() });
    return { input, final, memo, memo_json: h.json, memo_hash: h.hash, memo_hash_hex: h.hex, steps, card, plan };
  }

  async function retryWithChainError(prev: DeskResult, errorCode: string, opts?: RunOptions): Promise<DeskResult> {
    const previous = prev.final.proposal;
    if (!previous || previous.action !== "open") throw new DeskError("CONFIG", "retryWithChainError needs a previous result whose final proposal was an open_round");
    return runDesk({ ...prev.input, chain_retry: { previous_memo_hash: prev.memo_hash_hex, error_code: errorCode, previous_proposal: previous } }, opts);
  }

  return { runDesk, retryWithChainError };
}

async function ensurePlan(toolbox: Toolbox) {
  const r = await toolbox.call("get_plan", {}, "desk:get_plan");
  if (!r.ok || !toolbox.plan) throw new DeskError("TOOL_FAILED", `get_plan failed: ${r.error}`);
  return toolbox.plan;
}

/** Which proposal numbers appear verbatim in some successful tool output (evidence the LLM copied, not computed). */
export function provenance(p: QuantProposal, traces: { ok: boolean; result?: unknown }[]): Record<string, boolean> {
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") seen.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v as object).forEach(walk);
  };
  for (const t of traces) if (t.ok) walk(t.result);
  const out: Record<string, boolean> = {};
  for (const k of ["strike", "size", "expiry", "premium_start", "premium_floor"] as const) {
    const v = p[k];
    out[k] = v !== null && seen.has(String(v));
  }
  return out;
}

/**
 * Did the rationale cite recent_outcomes (agents v2)? true = it quotes at least one number from that tool's output, or
 * says there were no past rounds; false = it did not; null = the tool was never called successfully. Informational.
 */
export function citesRecentOutcomes(rationale: string, traces: { name: string; ok: boolean; result?: unknown }[]): boolean | null {
  const t = [...traces].reverse().find((x) => x.name === "recent_outcomes" && x.ok);
  if (!t) return null;
  if (/\b(no|0|zero) (past |previous |prior |finished )?rounds|no (outcome )?history|no track record/i.test(rationale)) return true;
  const nums = groundedNumbers(t.result);
  // Ignore tiny integers (0–2): they appear everywhere and prove nothing.
  return thesisNumbers(rationale).some((n) => nums.has(n) && !["0", "1", "2"].includes(n));
}

/** Production wiring from env: Z.ai transport + RiskJudge per RISK_BACKEND (GLM fallback). */
export function createDeskFromEnv(tools: DeskTools, env: Record<string, string | undefined> = process.env, cfg: DeskConfig = readDeskConfig(env), wrap?: (t: ChatTransport) => ChatTransport): Desk {
  const base = createZaiTransport({ apiKey: cfg.zai.apiKey, baseUrl: cfg.zai.baseUrl, timeoutMs: cfg.zai.timeoutMs });
  // `wrap` routes every desk GLM call (Quant + GLM risk fallback) through the worker's shared serial queue.
  const transport = wrap ? wrap(base) : base;
  const risk = createRiskJudge({
    backend: cfg.risk.backend,
    glm: { transport, model: cfg.zai.modelRisk },
    clef: { accountId: cfg.risk.cfAccountId, token: cfg.risk.cfToken, model: cfg.risk.clefModel, localUrl: cfg.risk.localUrl, timeoutMs: cfg.risk.timeoutMs },
  });
  return createDesk({ tools, transport, risk, quantModel: cfg.zai.modelMain, maxToolRounds: cfg.quant.maxToolRounds });
}
