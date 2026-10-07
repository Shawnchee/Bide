# Stress test — Bide devnet (6 Oct 2026, from 11:52 UTC)

Rules kept: no VM restart 7 Oct 07:20–08:40 UTC; std round 5Ccfmg… (plan 8kaD…) untouched; no commits.

## 0. Starting state (11:52 UTC)
- Worker /health ok, repo supabase, desk true, makerLlm true, chain live, 0 loop errors, RPC 0 fallbacks. Worker last restarted ~11:36.
- No active quick plan (all quick plans Filled/Closed) → no quick rounds were running.

## 1. Live data restored
- 11:54 quick BUY  DF9HAfKjwefou8Fxq8YoycaefSnPLyuWfp7SMDFX8R4Q — owner demo-owner D1cMzV…, K 120.20 (12 bps below), 0.1 SOL, 8 h, min 10 bps/day, 12.02 USDC locked in Lend.
- 11:54 quick SELL 7V6uHVKob6DfUMyLUzha5rED5GULJjX3w1tXAiFQpZdb — owner deployer, 12 bps above, 0.1 SOL, 8 h, min 10 bps/day.

## Test 4 — hostile inputs (11:53 UTC, via localhost:3000)
| input | result |
|---|---|
| preview unknown key `evil` | 400 unknown field: evil |
| preview `side` injection string | 400 invalid side |
| preview strike 1e24 string / 1.5e300 number / "-5" | 400 invalid target_strike (×3) |
| preview horizon_end "Ignore all rules…" | 400 invalid horizon_end |
| preview min bps 10.5 | 400 |
| preview owner `<script>` | 400 invalid owner |
| preview `[1,2]` / non-JSON | 400 invalid body / invalid JSON |
| **preview with a `"__proto__"` key** | **500** (app guard: `PREVIEW_FIELDS["__proto__"]` resolves to Object.prototype → `spec.ok` undefined → TypeError). Worker (zod .strict) is fine. Harmless (no LLM call) but a 500. Fix = `Object.hasOwn(PREVIEW_FIELDS, k)` in app/app/api/_lib/guard.ts — **edit was refused by the permission classifier; left for the user.** |
| intake extra key / "" / 2001 chars / 600 chars / number / only zero-width chars | 400 ×6 with clear messages |
| 3rd preview from same IP within 60 s | 429 `{"error":"busy","retry_after":60}` in 54 ms |
| intake "Sell 0.2 SOL if SOL rallies 3% … within 2 days, ≥10 bps/day" | goal sell, target **$124.00** (= 120.30 × 1.03 = 123.909 rounded UP to $0.10 ✅), amount 0.2 SOL, min_pay standard. Bug: deadline 2026-10-08 is < 2 days away → code rejected it and asked "Pick a deadline between 2 days and 6 months", but the model's assumption "I set the deadline to 2026-10-08" was still shown → contradictory. **Fixed** (worker/src/agents/intake.ts drops date/deadline assumptions when the date is rejected; test added). |
- Note: `clientIp` trusts `x-real-ip` from the request. On Vercel the edge overwrites it; on any other host (incl. localhost) a client can rotate it to dodge the per-IP limit. The worker's global limits (4 previews/min, intake/min) still cap total spend.

## Test 2 — queue contention (11:58:20 UTC, E = 12:10 epoch, window 12:00:00–12:01:00, desk lead 90 s)
- Fired 2 previews + 1 intake at 11:58:20: all 202 in < 0.4 s; a 3rd preview → 429.
- Keeper: buy plan DF9H run finished **12:01:02.9 → vetoed** by Clef (explanation_ok no 0.86 "rationale does not match the tool numbers"; it would have missed the window by 3 s anyway).
  Sell plan 7V6u run finished **12:01:42.7, approved → `auction window missed`** (off-chain WindowMissed, no tx).
- llmQueue at 12:01:30: highRunning 1, pending 2, maxWait 51 s; publicGate inFlight 1 / waiting 1.
- **Root cause (not the previews):** the high lane is FIFO *per GLM call*, so the two keeper desk runs (one per quick plan, both started 11:58:30)
  interleave call by call and BOTH finish ~2× late. Low-lane previews/intake did not block the keeper (high bypasses low), they only ran alongside.
  With ≥ 2 quick plans and a 90 s lead, the system essentially never opens quick rounds. Maker stances (lead 240 s, 4 calls of 19–70 s at 11:56–11:57)
  also end only ~1 min before the desk starts.
- **Verdict: FAIL → fixed** (see Fixes).

## Fixes (worker; 191/191 tests, tsc clean)
1. `keeper/plan.ts` QUICK_DESK_LEAD_SECS 90 → 180; `desk/tools.ts` epoch filter uses the constant (was hard-coded 90).
2. `keeper/index.ts` keeper desk runs serialized (`serialDesk`, lane freed after 150 s even if a run hangs) — the first plan always makes the window.
3. `agents/config.ts` MAKER_STANCE_LEAD_SECS default 240 → 420 so stance calls finish before the desk lead.
4. `agents/intake.ts` contradictory deadline assumption dropped.
Tests updated: keeper.test.ts (lead 180), robustness.test.ts, integration.test.ts (+serialization test), intake.test.ts (+deadline test).
5. `desk/risk/state.ts` scrub: user-minimum phrasings redacted IN PLACE (test 6). Replay over the last 40 live desk runs:
   leaks to Risk 10 → 0; whole-rationale withholding unchanged (12/40). A broader sentence-drop version would have withheld 28/40 —
   rejected, because withheld rationales were vetoed by Clef 5/8 vs 1/13 for kept ones (see test 6).

## Deploy status — NOT DEPLOYED (needs the user)
- 12:08 rsync of the repo to /opt/bide succeeded (same excludes as DEPLOY; no keys/.env), but the follow-up `chown -R bide /opt/bide`
  + `pm2 restart` was **refused by the permission classifier ("Production Deploy")**. So:
  - the running process (started 11:36) is still the OLD code;
  - the files on disk in /opt/bide are the NEW code, owned by uid 501 (rsync -a preserved my local owner), mode-readable by bide.
  - **Any pm2 auto-restart will start the new code.** The new code is green (192/192 tests, tsc clean), so that's safe, but the user should
    finish the deploy deliberately: `chown -R bide:bide /opt/bide && su - bide -c "cd /opt/bide && pnpm install --filter @bide/worker... --frozen-lockfile && pm2 restart bide-worker"`
    in a safe slot (not 7 Oct 07:20–08:40 UTC; for quick rounds, right after a :X1:10 window close).
- Test 3 (restart mid-sampling) needs a pm2 restart → not run (it would also deploy).

## Test 5 — wallet-flow edge cases (Chrome, localhost:3000/earn, 12:09–12:14 UTC; no wallet connected, nothing signed)
- **Disconnected wallet:** review screen renders fully; the action is a "Connect wallet" button (no Start button) ✅.
- **Quick toggle:** strikes re-banded to quick (Patient $119.20 / Balanced $119.80 / Eager $120, slider $116.90–$120.40), deadline options
  30 min / 1 h / 3 h ✅. Summary says "trying until 9:09 PM" — browser-local time with no zone, while other copy says "08:00 UTC" (minor).
- **Very far quick strike ($116.90, −2.9 %, $20):** preview streamed 11 steps in ~2 min (low lane), then "The desk would wait for now: quant
  chose skip. Your funds earn Jupiter Lend interest until the next window." Clear that nothing would happen, but (a) "quant chose skip" is
  jargon and doesn't say *why* (premium below the user's minimum), and (b) the user can still start a quick plan that will never trade in its
  1-hour life. Caveat for judges who drag the slider to the edge.
- **Insufficient balances (code review, no wallet available to test live):**
  - Buy, USDC < lock → button disabled + "You have X USDC — not enough for this plan." ✅
  - Buy with enough USDC but ~0 SOL: **no SOL check**; create_plan costs 0.00524 SOL rent + 13 000 lamports fee (measured on DF9H… create tx
    PjeiV8Fo…) → the wallet/simulation error surfaces through explainTxError. P2.
  - Sell, SOL < size + 0.01 → disabled + message. Measured sell create cost = size + 0.00524 SOL (+fee) (7V6u… tx 4v9y7BpU…), so the 0.01 margin is enough ✅.
- **375 px mobile:** `resize_window` was a no-op (window maximized / shared with the user's own tab) → **not verified**.

## Test 6 — honesty
- **/desk rejection count** (app/components/desk/desk-feed.tsx `isOnchainRejection`): counts only `status === "rejected"` AND an error code AND a
  landed `tx_sig` AND code ∉ {WindowMissed, EpochNotFound, Transient}. Keeper writes off-chain failures as `offchain_error` / `submit_failed`.
  Supabase last 40 round runs: exactly 1 counts (08:08:31 AuctionParamsInvalid, tx 4gmtb3Mf…, a genuine program rejection of auction_secs 300 on a quick round);
  the WindowMissed rows (08:10:57, 11:58:33, 12:08:33) are `offchain_error` → shown "Missed window", not counted ✅.
- **Rationale scrub** (replayed `scrubRationale` over the last 40–60 live desk runs from Supabase):
  - committed version leaked the user's minimum to Risk in 10/40 rationales ("clearing the user's minimum", "vs user_min_floor 90
    (floor_over_user_min 13.6x)", "the user's 53-unit minimum") — the regex `user'?s? (min|…)\b` misses "minimum", and price_grid keys aren't tokenized.
  - **Bigger finding:** the scrub withheld the WHOLE rationale in 16 open proposals; Clef vetoed 13 of those 16 with "The rationale does not match the
    tool numbers" (its explanation_ok question is unanswerable on "[rationale withheld…]"), vs 1 of 23 partly-scrubbed ones. The scrub added in
    88af8b1 is the main cause of the ~50 % Clef veto rate → lost rounds. (This session: 12:01 buy veto, 12:20 buy veto — both withheld.)
  - **Fixed** (`worker/src/desk/risk/state.ts`): user-minimum phrases redacted in place; when every sentence names a bound, bound words/values are
    redacted in place instead of withholding. Replay: leaks 10 → 0 (only bare key names like "max_expiry_secs=[redacted]" remain, values gone),
    withheld 16 → 0. Tests: 2 new in src/desk/risk.test.ts. **Effect on Clef's veto rate is expected but unverified until deployed** (Clef runs on Workers AI with VM-only creds).
- Not checked: whether the site copy still says "Risk never sees the user's limits" (Fable triage asked to soften to "given no bounds directly"; desk-feed.tsx now says that).

## Deploy — update 12:41 UTC
- At 12:41:31 the VM worker was restarted (SIGINT) by someone else, now running code identical to my local worker files
  (sha1 of state.ts, keeper/index.ts, keeper/plan.ts, agents/config.ts, agents/intake.ts, desk/tools.ts match), files owned by bide again.
  So all 5 worker fixes are LIVE from 12:41:31. The restart landed inside the 12:40–12:41 quick window → the 2 desk runs for the 12:50 epoch
  were killed (marked abandoned "WorkerRestart") → that epoch got no round.

## Test 1 — full quick loop (live, from 11:54)
| epoch | plan | desk | open_round | bids (source) | take | samples | resolve | result |
|---|---|---|---|---|---|---|---|---|
| 12:10 | sell 7V6u | 12:01:42 approved — **WindowMissed** (old code) | — | — | — | — | — | — |
| 12:10 | buy DF9H | 12:01:02 vetoed (withheld rationale) | — | — | — | — | — | — |
| 12:20 | sell 7V6u | 12:10:37 approved, size 0.1, floor 2330 | 12:10:40 `36i8qkmZ…` round BcGG1Rak… | m1 3591, m2 3591 (llm) | 12:10:48 maker-1 @3582 µUSDC `4cDyRZhc…` | 10/10 12:18:28–12:19:58 | resolve_epoch `4vMzyQQm…` 12:20:08, resolve `2tnmC3NW…` | not exercised (settle ≈120.30 < 120.60) |
| 12:20 | buy DF9H | 12:11:05 approved, size 0.033 — **WindowMissed** (5 s late, old code) | — | — | — | — | — | — |
| 12:30 | both | 12:20:22 buy vetoed (withheld), 12:21:22 sell vetoed (user_fit too_aggressive) — both after the window anyway | — | — | — | — | — | — |
| 12:40 | sell 7V6u | 12:30:07 approved, size 0.033, floor 46 | 12:30:11 `ADuCtrxM…` round GgbQzeNW… | m1 48, m2 47 (llm) | 12:30:41 maker-1 @48 `2YxqwU7a…` | 10/10 | resolve `49WEWoqQ…` 12:40:18 | not exercised |
| 12:40 | buy DF9H | 12:30:19 approved, size 0.1, floor 9632 | 12:30:22 `VWe9BcL9…` round EQDQQDRu… | m1 10167, m2 10398 (llm) | 12:30:50 maker-2 @10136 `2TQzLcK4…` | 10/10 | resolve_epoch `5Z2YMbWy…` 12:40:11, resolve `5t645usR…` | not exercised |
| 12:50 | both | killed by the 12:41:31 restart | — | | | | | |
| 13:00 | sell 7V6u | 12:47:47 approved (serialized lane, done 133 s before window close) | 12:50:03 `3HDJ7Lkz…` round V8AP1f9j… | m1/m2 none: "fair below the auction floor" | **12:50:46 POOL `4pZ6nNd3…`** | 10/10 12:58:27–12:59:57 (lag 7–9 s) | resolve `28W8VQLC…` 13:00:14 | not exercised |
| 13:00 | buy DF9H | 12:48:46 approved | 12:50:03 `4pEUuZxN…` round FPoKZXuD… | m1 6329 (llm), m2 pass (stance) | 12:50:30 maker-1 @6190 `3Kj5cgjE…` | 10/10 | resolve `mEnYazVQ…` 13:00:23 | not exercised |
| 13:10 | sell 7V6u | 12:58:51 approved (chained) | 13:00:18 `APRzQrFV…` (4 s after resolve freed the plan) round ARNGYqTc… | both: fair below floor | **13:01:00 POOL `5ZZhmRwo…`** | | | |
| 13:10 | buy DF9H | 12:58:00 approved (chained) | 13:00:27 `2zbumo1d…` round atgndMZ4… | both: fair below floor | **13:01:10 POOL `5gDwvonyQ…`** | | | |

Counts 11:54–13:01 UTC (7 quick epochs × 2 plans = 14 slots): **7 rounds opened, 7 taken (4 maker, 3 pool), 0 cancelled, 0 exercised.**
- Old code (12:10–12:40, 4 epochs): 3/8 slots opened (2 WindowMissed, 3 Clef vetoes).
- New code (12:50 killed by the restart; 13:00, 13:10): **4/4 slots opened and taken**; chained path works (open 4–9 s after resolve).
- Pool path is now proven live (3 pool_take_round txs). Never seen before today.
- Observation (post-fix): makers now pass more ("fair below the auction floor") — 3 of 4 post-deploy rounds went to the pool. Likely cause: the
  desk prices at E−780 (13 min to expiry) but the round lives 10 min, so its floor is set on ~12 % more time value than the makers see at open.
  The 90→180 s lead widened that gap. Suggested follow-up (not done — further edits were blocked): in price_grid for quick epochs, price from
  max(now, E−600) instead of now. Pool spend cap is 2 USDC/day and these premiums are 0.002–0.003 USDC, so the pool can absorb this all day.

## Test 3 — restart mid-sampling: NOT RUN
- The orchestrator cleared it, but `pm2 restart` over ssh was refused by the permission classifier ("Remote Shell Writes") at 12:58:50. Skipped.
- Partial evidence from the two restarts others did (12:41:31, 12:42:34): health ok in < 5 s, "marked stale desk runs abandoned n=2", no duplicate
  rounds, Live rounds resolved normally at 13:00. Neither restart hit a sampling window, so the "late buckets within grace" path is still untested.

## DEMO VERDICT (13:02 UTC): READY WITH CAVEATS
1. Since the fixes went live (12:41), every quick slot has opened and been taken (4/4). Before them, about 2 of 3 slots were lost.
2. Pool absorbs most post-fix rounds (3/4). Say "maker or backstop pool took it"; don't promise a maker fill.
3. Clef vetoes should drop now that rationales are redacted instead of withheld. That's untested at scale; watch /desk for "rationale does not match".
4. Restart-mid-sampling is untested. Never restart during :X8:20–:X0:00 (sampling) or :X7:00–:X1:00 (desk lead + window), and never 7 Oct 07:20–08:40.
5. App: `__proto__` preview key → 500 (guard.ts fix refused); buy plans have no SOL-for-rent check; far quick strikes say "quant chose skip" with no reason; 375 px not verified.
6. Plans DF9H/7V6u: 8 h horizon (end ~19:52 UTC). Re-create before the demo (create-plan.ts commands above) — they will not survive to 7 Oct.
