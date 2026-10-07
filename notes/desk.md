# Agent desk (A lane): notes, contract and VERIFY status

Written 2026-10-05, about 15:00 UTC. The code lives in `worker/src/desk/`. Tests: `pnpm --filter @bide/worker test` (41 desk tests pass).

## Contract for W (`worker/src/desk-api.ts` did not exist yet)

```ts
import { createDeskFromEnv, type DeskTools } from "./desk/index.js";
const desk = createDeskFromEnv(tools);            // tools: W's DeskTools implementation
const r = await desk.runDesk({ plan_id, kind: "round" | "preview", patience }, { onStep });
// r.final.status: "open" | "skip" | "flip" | "stop" | "vetoed" | "error"
// "open"  → open_round(strike, size, auction_secs, premium_start, premium_floor, memo_hash = r.memo_hash)
//           on the Epoch whose expiry = r.final.proposal.expiry. Submit it AS-IS. No clamping.
// "flip"  → flip_plan. "skip" / "vetoed" / "error" → no tx this cycle. "stop" → nothing (or expire/close per keeper rules).
// When open_round is rejected → const r2 = await desk.retryWithChainError(r, "StrikeOutOfBounds"); submit r2 if "open". Only once.
```

- **Types:** `worker/src/desk/types.ts`.
  - Every u64 is a decimal **string** in base units (BUILD §3.1).
  - `expiry` is integer unix seconds.
  - `memo_hash` is a 32-byte `Uint8Array`; `memo_hash_hex` is its hex form.
- **desk_runs row:**
  - `steps` ← `r.steps`, or stream them from `onStep`.
  - `proposal` ← `r.memo.quant_proposal`.
  - `verdict` ← `r.memo.clef_answers`.
  - `final` ← `r.final`.
  - `memo` ← `JSON.parse(r.memo_json)`.
  - `memo_hash` ← `r.memo_hash_hex`.
  - `status` ← `r.final.status`.
  - Card for the UI ← `r.card` (`text`, `lines`, `warning`, `numbers`).
- **Re-hashing:** canonicalising the stored memo again gives the same sha256. Floats are pre-rounded to 6 dp, keys are sorted, and Postgres jsonb key reordering does not matter.
- **`DeskTools`, which W implements.** Methods: `get_plan`, `get_spot`, `price_grid`, `fill_probability`, `lend_apy`, `venue_dispersion`, `spot_moves`. `event_calendar` is served by the desk itself.
  - **`get_plan`** must return `open_epochs`: every open epoch for the asset, **not filtered by the plan bounds**. It also returns `fee_bps` from Config and `strike_tick`.
  - **`price_grid(asset, kind, strikes[], expiries[], size)`** returns cells with **totals for `size`** in USDC base units, as strings: `fair_premium`, `bid_premium`, `premium_start`, `premium_floor`. The pricer's `PriceResult` uses JS numbers (`strike` in $, `size` in whole asset, `expiryMs`), so W's adapter converts:
    - strike / 1e6
    - size / 10^decimals
    - expiry × 1000
    - premiums: `BigInt(Math.round(x))`
    - A `PriceFailure` becomes a cell with `error: reason`.
  - **`fill_probability`** can reuse `PriceResult.fillProbability`.
  - **`lend_apy`** returns bps, or null.
- **The keeper must not drop a proposal whose expiry has no Epoch account.** Record it in `desk_runs.error_code` as `EpochNotFound` and call `retryWithChainError(r, "EpochNotFound")`. That is an off-chain failure, so the UI must not count it as an on-chain rejection.

## What the desk does
1. **Quant** (`quant.ts`) runs a tool loop, at most 8 rounds (`DESK_MAX_TOOL_ROUNDS`).
   - After the budget, it gets one final turn without tools.
   - Its output is validated by zod (`schema.ts`). That checks types and u64/u32 ranges only, **never plan bounds**.
   - If the output is invalid, it gets one repair turn. If that is still invalid, the result is `status: "error"` and no round opens.
2. **Toolbox** (`tools.ts`) adds deterministic derived fields so the LLM never does arithmetic:
   - ladder sizes (all, ½, ⅓ of the remainder, snapped to 0.001 asset)
   - the distance band (SPEC §6)
   - per cell: days to expiry, notional, `user_min_floor` (the exact open_round inequality in BUILD §3.3, after fee) and `floor_over_user_min`
   - USD strings next to the base units

   Nothing is filtered or clamped. Every tool call goes into `tool_traces`, including failures.
3. **Risk** (`risk/`) is sent a whitelist-built state:
   - **Included:** the proposal, spot, the matching price cell, fill probability, venue dispersion, spot moves, Lend APY, events before expiry, and the user's stated patience.
   - **Excluded (tested):** strike range, min yield, max expiry, horizon, remaining size, rate limits and the `user_min_floor` helpers.
4. **Binding** (`risk/binding.ts`):
   - Take the argmax of the verdict; ties go to the more conservative verdict.
   - `veto` → `vetoed`.
   - `adjust` → one Quant retry using the top concern, chosen deterministically as the highest-probability "bad" option. Risk judges the retry: a veto means `vetoed`; otherwise the retry is final. There is no second retry.
5. **Risk backends:** the order is `RISK_BACKEND` first, then `glm` as fallback. If every backend fails, the status is `error`, so the desk fails closed: no open_round without a risk check. Fallbacks are recorded in the memo.
6. **Memo** = `{inputs, quant_proposal[], clef_answers[], final, tool_traces, model_ids, timestamps, provenance}`, turned into canonical JSON and hashed with sha256.
   - `provenance` records whether each proposal number appears verbatim in a tool output. It shows the LLM copied the number rather than computing it. It is informational and never blocks.
7. **Card** (`card.ts`) is deterministic.
   - It shows the pay range after the fee (floor to start, because the auction price is unknown at preview).
   - It covers "checked once at …, not on touch", the dip-and-recover example, and the crash case (puts) or rally case (calls).
   - It includes a Lend interest estimate and "Same price as a limit order, different trigger."
   - A test fails if the template uses put, call, strike, premium, option, expiry or exercise.

## Honest framing (SPEC §21–22)
- **The prompt** says the program checks every open_round against the user's signed limits, the keeper submits as-is, and a rejection is public. It does **not** forbid out-of-bounds values, and it is not tuned to provoke them. A test asserts both.
- **Known leak:** the Quant's free-text rationale goes to Risk. If the Quant writes the bounds into its rationale, Risk sees them. This is not scrubbed. Risk's typed questions do not ask about bounds.

## Env (names only)
| Variable | Default / note |
|---|---|
| `ZAI_API_KEY` | required for Quant and the GLM risk fallback |
| `ZAI_BASE_URL` | default `https://api.z.ai/api/paas/v4`; Coding Plan keys use `https://api.z.ai/api/coding/paas/v4` |
| `ZAI_MODEL_MAIN` | default `glm-5.3` |
| `ZAI_MODEL_RISK` | optional, new; defaults to the main model |
| `RISK_BACKEND` | default `workers-ai` |
| `CF_ACCOUNT_ID`, `CF_AI_TOKEN` | Clef on Workers AI |
| `CLEF_MODEL` | optional, new: `clef` / `clef-flash`; default `clef` |
| `CLEF_LOCAL_URL` | local Clef service |
| `DESK_MAX_TOOL_ROUNDS`, `ZAI_TIMEOUT_MS`, `RISK_TIMEOUT_MS` | optional, new |

A missing key raises `MissingSecretError` (code `MISSING_SECRET`, names the variable) when the adapter is first called. The run then ends with `status: "error"`.

**Live check once keys land:** `pnpm --filter @bide/worker exec tsx src/desk/verify-live.ts`. It prints NAME=SET/EMPTY only, makes up to 3 calls, and prints the tool-call and Clef answer shapes.

## VERIFY status
**Z.ai.** Confirmed from docs.z.ai by a research subagent on 2026-10-05:
- `POST {base}/chat/completions` with Bearer auth.
- OpenAI-style `tools`; `tool_calls[].function.arguments` is a JSON string.
- `tool_choice` accepts **only `"auto"`**.
- `response_format` accepts only `json_object`; `json_schema` is not documented. Strictness therefore comes from zod plus one repair.
- `glm-5.3` is listed.
- GLM-5.3 **forces thinking**, which cannot be disabled. Expect latency and extra tokens on every turn.

Not yet verified:
- Whether our key is a Coding Plan key, which decides the base URL.
- Whether multi-turn tool calling needs `reasoning_content` echoed back. We don't echo it.
- The non-streaming `reasoning_content` field name, which is inferred.
- Real latency per desk run, which could be several thinking turns.

**Clef.** Confirmed at developers.cloudflare.com/workers-ai/models/clef:
- Model ids `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`.
- The body **requires `model`** (`clef` | `clef-flash`) even though it is also in the URL.
- `state` is a string or an object.
- `questions` is an **object keyed by id** (1–64), with `type` ∈ {choice, score, noul}, plus `instructions` and `criteria`. For choice, `criteria` is `{option: description}`; for score, it is ordered labels from lowest to highest.
- The result is `{model, answers, usage}`.
- Pricing is $0.24/M input tokens for Clef and $0.09/M for flash. The Workers AI free tier is 10k neurons/day.

**Assumed from a secondary source (flaviocopes.com/clef):**
- The REST envelope is `{result, success, errors}`.
- A choice answer is `{choice, probabilities, confidence}`.
- A score answer is `{score, legend, probabilities}`.
- A noul answer is a probability.

The parser accepts every one of these variants and fails loudly (`RISK_OUTPUT_INVALID`) on anything else. One real call settles it; then tighten the parser.

## Event calendar
`worker/src/desk/data/events.json` holds only dates read from the official pages on 2026-10-05:
- **FOMC:** Oct 28, Dec 9 (with SEP), Jan 27 2027. These are tentative until confirmed.
- **CPI:** Oct 14, Nov 10, Dec 10.
- **Jobs reports:** Nov 6, Dec 4.

FOMC statements are at 2:00 pm ET by standard practice; the calendar page does not restate the time. The UTC times account for DST ending on Nov 1.

## Deviations / decisions (for the SPEC decision log, owner to apply)
- **Risk runs only for `open`.** skip, flip and stop are not risk-checked.
- **After an `adjust` retry, Risk judges again.** Veto stops the round; adjust or approve both accept it. There is no second retry.
- **If no risk backend is available, the desk fails closed** and opens no round. BUILD says nothing on this point.
- **`explanation_ok` uses Clef's `noul` type**, so it gets a single probability, mapped to {yes, no}.
- **Card pay line:** "You get $X–$Y now (after fee)" (floor to start), because the auction price is unknown when the desk runs.
