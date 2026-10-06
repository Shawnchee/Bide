/**
 * Quant — GLM (Z.ai, OpenAI-compatible) tool-calling loop that proposes one round.
 *
 * Framing (SPEC §21–22, BUILD §5): the prompt tells the model the program enforces the user's
 * limits and rejects proposals that break them; it does NOT forbid any value, and it is never
 * tuned to provoke rejections. All numbers come from tools.
 */
import type { ChatMessage, ChatTransport } from "./llm/chat.js";
import type { QuantProposal } from "./types.js";
import { TOOL_DEFS, type Toolbox } from "./tools.js";
import { parseQuantProposal, QUANT_OUTPUT_SHAPE } from "./schema.js";
import { DeskError } from "./errors.js";

export const QUANT_SYSTEM_PROMPT = `You are the Quant on Bide's agent desk. Bide runs "name your price, get paid until it fills" plans on Solana devnet. Under the hood each round is a physically settled, fully collateralised option sold to makers in a Dutch auction:
- Buy plans (and Wheel plans in the accumulate phase) sell cash-secured PUTS at the user's buy price.
- Sell plans (and Wheel plans in the exit phase) sell covered CALLS at the user's sell price.
Every round joins a shared epoch (an expiry). At expiry a Pyth median decides whether the user buys/sells at exactly the strike. The user keeps the premium either way. Collateral earns Jupiter Lend interest meanwhile.

Your job: propose exactly ONE action for this plan for this cycle.
- "open": open a round now (strike, size, expiry, auction_secs, premium_start, premium_floor).
- "skip": do not open a round this cycle (collateral keeps earning in Jupiter Lend).
- "flip": a Wheel plan whose buy goal is fully filled moves to the sell side.
- "stop": the goal is met or the plan cannot continue.

How to decide (use the tools; never guess numbers):
1. Call get_plan, get_spot, event_calendar and recent_outcomes first. Call get_plan again after get_spot if you want the distance band.
2. Expiry — choose by how far the user's price is from spot: within 3% of spot → 1–2 days; 3–8% → about 1 week; more than 8% → 2–4 weeks. Quick plans use the nearest quick epoch. The user wants it done by their deadline. Pick among the epochs that are open on-chain (get_plan → derived.epochs_matching_plan_kind). Use price_grid to compare the premium for candidate expiries; the choice must be evidence-based.
3. Size — ladder toward the goal rather than all at once: typically a third of the remaining size per round (get_plan → derived.ladder_size_options); use all of it when the remainder is small or the deadline is close.
4. Strike — the user's price (get_plan → derived.user_price). If the user unlocked the price, you may pick a strike that is better for the user (puts: lower; calls: higher) when price_grid shows it is still worth it.
5. Premiums — copy premium_start and premium_floor from the chosen price_grid cell. Do not invent or adjust them by hand.
6. auction_secs — quick plans: 30 (program limit 5–120); std plans: 300 (limit 10–1800; market makers need time to price a multi-day option). Use another value only with a reason, and never outside the limit.
7. Skip when: a scheduled macro event (FOMC, CPI, jobs report) falls inside the round and the premium does not pay for that risk; fewer than 2 venues price the cell, or venues disagree a lot (venue_dispersion); the floor barely clears the user's minimum (price_grid → floor_over_user_min close to 1); or the pricer returns an error.
8. Flip / stop — see get_plan (side, phase, size_filled vs size_total, status).
9. Track record — call recent_outcomes once. Its statistics (fill rate, fill price / start, seconds to fill, untaken rounds, exercise rate, maker wins) may inform auction_secs, expiry, size or skip. Premiums still come from the price_grid cell, and the statistics never change the strike. Samples are small: weigh them lightly. Your rationale must cite at least one recent_outcomes number, or say that there are no past rounds.

Enforcement: the Bide Solana program checks every open_round against the limits the user signed (price range, size, expiry and deadline, minimum yield after fee, auction parameters, rate limits). The keeper submits your proposal as-is; if it breaks a limit, the program rejects it on-chain and the rejection is public.

All amounts are integers in base units, written as decimal strings: prices and premiums in USDC base units (6 decimals, $110 = "110000000"), size in asset base units (SOL 9 decimals, 0.2 SOL = "200000000"). expiry is integer unix seconds. Copy numbers from tool outputs; do not do arithmetic yourself.

When you are done with tools, reply with ONLY this JSON object (no prose, no code fences):
${QUANT_OUTPUT_SHAPE}
For skip / flip / stop, set every numeric field to null. The rationale is plain English, 2–4 sentences, and cites the tool numbers you relied on.`;

export interface QuantRunOptions {
  transport: ChatTransport;
  model: string;
  toolbox: Toolbox;
  maxToolRounds: number;
  onToolCall?: (name: string, ok: boolean) => void;
  onRepair?: (error: string) => void;
}

export interface QuantRunResult {
  proposal: QuantProposal;
  messages: ChatMessage[];
  model: string;
  tool_rounds: number;
  repaired: boolean;
}

export function quantUserMessage(ctx: { plan_id: string; now_ms: number; kind: string }): string {
  return JSON.stringify({
    task: "Propose this cycle's action for the plan.",
    plan_id: ctx.plan_id,
    now_utc: new Date(ctx.now_ms).toISOString(),
    now_unix: Math.floor(ctx.now_ms / 1000),
    run_kind: ctx.kind,
  });
}

/** Runs the tool loop from `messages` (system + user already included) until a valid proposal. */
export async function runQuant(messages: ChatMessage[], o: QuantRunOptions): Promise<QuantRunResult> {
  const msgs = [...messages];
  let rounds = 0;
  let model = o.model;
  let final: string | null = null;

  while (final === null) {
    const budgetLeft = rounds < o.maxToolRounds;
    if (!budgetLeft) {
      msgs.push({ role: "user", content: "Tool budget used up. Reply now with the final JSON object only." });
    }
    const res = await o.transport.complete({ model: o.model, messages: msgs, tools: budgetLeft ? TOOL_DEFS : undefined, temperature: 0.2 });
    model = res.model || model;
    if (res.tool_calls.length && budgetLeft) {
      rounds++;
      msgs.push({ role: "assistant", content: res.content ?? "", tool_calls: res.tool_calls });
      for (const tc of res.tool_calls) {
        let args: unknown = {};
        let out: { ok: boolean; result?: unknown; error?: string };
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          out = await o.toolbox.call(tc.function.name, args, tc.id);
        } catch (e) {
          out = { ok: false, error: `arguments were not valid JSON: ${(e as Error).message}` };
        }
        o.onToolCall?.(tc.function.name, out.ok);
        msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out.ok ? out.result : { error: out.error }) });
      }
      continue;
    }
    if (!res.content || !res.content.trim()) {
      if (!budgetLeft) throw new DeskError("QUANT_NO_ANSWER", "Quant returned no content after the tool budget");
      rounds = o.maxToolRounds; // force a final answer next turn
      continue;
    }
    final = res.content;
    msgs.push({ role: "assistant", content: final });
  }

  let parsed = parseQuantProposal(final);
  let repaired = false;
  if (!parsed.ok) {
    o.onRepair?.(parsed.error);
    repaired = true;
    msgs.push({ role: "user", content: `Your reply did not match the required JSON: ${parsed.error}. Reply with ONLY the corrected JSON object.` });
    const res = await o.transport.complete({ model: o.model, messages: msgs, temperature: 0 });
    const text = res.content ?? "";
    msgs.push({ role: "assistant", content: text });
    parsed = parseQuantProposal(text);
    if (!parsed.ok) throw new DeskError("QUANT_OUTPUT_INVALID", `Quant output invalid after one repair: ${parsed.error}`, { reply: text.slice(0, 1000) });
  }
  return { proposal: parsed.value, messages: msgs, model, tool_rounds: rounds, repaired };
}

/** Plain-language meaning of on-chain error codes, given to the Quant on a chain retry. No bound values. */
export const CHAIN_ERROR_HINTS: Record<string, string> = {
  StrikeOutOfBounds: "the strike is outside the price range the user signed",
  StrikeOffTick: "the strike is not on the asset's price tick",
  SizeTooLarge: "the size is larger than what remains of the user's goal",
  ExpiryOutOfBounds: "the expiry is later than the user's longest round or deadline",
  PremiumBelowUserMin: "the premium floor (after the platform fee) is below the user's minimum yield for that expiry",
  AuctionParamsInvalid: "the auction parameters are invalid (premium_start must be between premium_floor and 3x premium_floor; auction_secs must fit the window)",
  OutsideAuctionWindow: "the round was submitted outside the epoch's auction window",
  EpochKindMismatch: "the epoch kind does not match the plan (quick plans use quick epochs only)",
  EpochNotOpen: "the chosen epoch is not open",
  RateLimited: "the plan hit its rounds-per-day limit",
  ActiveRoundExists: "the plan already has a live round",
  SettlementPending: "a previous round is still settling",
  StalePrice: "the oracle price was stale at submission",
  PriceConfidenceTooWide: "the oracle confidence was too wide at submission",
  EpochNotFound: "no epoch account exists for that expiry (pick an expiry from the open epochs)",
};

export function chainRetryMessage(errorCode: string, previous: QuantProposal): string {
  return JSON.stringify({
    task: "Your previous proposal was submitted to the Bide program and rejected on-chain. Re-check with the tools and propose again (open, or skip if no round makes sense).",
    error_code: errorCode,
    meaning: CHAIN_ERROR_HINTS[errorCode] ?? "see the error code",
    previous_proposal: previous,
  });
}

export function riskAdjustMessage(concern: string): string {
  return JSON.stringify({
    task: "The risk reviewer asked for an adjustment. Address the concern below using the tools, then reply with the final JSON object (open with changed parameters, or skip).",
    concern,
  });
}
