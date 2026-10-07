# Adversarial Review — deeznuts (bide)

**Date:** 2026-10-06
**Scope:** Solana program (`programs/bide`), worker service (`worker/src`, `worker/test`, `supabase/`), frontend (`app/`). ~18k lines reviewed across three parallel adversarial reviewers.
**Method:** Design-stage adversarial review (not an audit). It reduces risk but does not replace a formal audit.

## Verdict

**No third-party-exploitable fund-theft path was found.** A prior review pass (Fable 5.1, per SPEC decision log) already closed the classic kills (escrow-donation lock, pool-take deadline, min round notional, pool receivable accounting, first-depositor share inflation). What remains falls into three buckets:

1. **Deployment posture / trust model** (program) — init front-run, single-key upgrade authority, no timelock on admin oracle/fee changes.
2. **Demo-killers** (worker + app) — stale Pyth spot priced as fresh, one failed pricing permanently blacklisting a round from all maker bots, default public RPC killing `/maker` under judge load, user-entered price silently overwritten by a preset.
3. **Honest-accounting / fairness gaps** (program + worker) — premium forfeited on oracle-failed unwinds, shortfall underpayment clearing the pool's receivable, maker P&L getting the wrong sign on fast quick-round settles.

## SQL executed during this review

**None.** No SQL was run against Supabase (local or hosted) or any other database at any point in this review. All database-related files (`supabase/reset-and-init.sql`, `worker/src/db/`, migration files) were **read only** — never executed. No migrations were applied, no queries issued, no data written.

---

# 1. Solana program (`programs/bide`)

## HIGH

**P-H1. `init_config` can be front-run on mainnet — attacker becomes admin.**
`programs/bide/src/instructions/admin.rs:5-24` has no authority constraint beyond `init`; `scripts/init-devnet.ts` sends `init_config` as a separate transaction *after* deploy.
*Scenario:* on mainnet the config PDA (`["config"]` is empty between deploy and init. Anyone watching the mempool calls `init_config` with their own `admin`/`agent`/`fee_recipient` — they own the protocol: `set_fee` up to 2,000 bps skim on every premium, `rotate_agent`, `add_asset` with oracle params they control, `set_paused` griefing. `init_pool` is admin-gated, so the pool is dead too.
*Fix:* initialize in the same transaction bundle as deploy (no gap), and/or derive config seeds to include the intended admin. Mainnet launch-gate checklist item.

**P-H2. Single-key upgrade authority on an upgradable program custoding all plan/pool collateral.**
Deployment posture documented in `SPEC.md:312` (deployer = upgrade authority *and* pool authority); `Anchor.toml` has no upgrade settings.
*Scenario:* compromise of the one hot deployer key = total loss of all deposited USDC/WSOL/fTokens via upgraded program logic. Same key is pool authority (can set `max_utilization_bps = 10_000`, unbounded `max_open_notional`, un-pause at will).
*Fix:* mainnet gate — move upgrade authority and pool authority to a Squads multisig before any real TVL; decide explicitly whether to freeze upgrade authority after the hackathon.

**P-H3. Admin unilaterally controls settlement-critical oracle params and the fee, no timelock.**
`admin.rs:74-84` (`apply_params` — `pyth_feed_id`, `spot_feed`, `max_conf_bps`, `max_spot_move_bps` all mutable any time), `admin.rs:43-48` (`set_fee` cap 2,000 bps = 20% of every premium; `fee_recipient` freely redirectable).
*Scenario:* compromised admin swaps an asset's `pyth_feed_id`/`spot_feed` to a different genuinely-Pyth-signed low-liquidity feed they can move, and/or raises `max_conf_bps`; settlement prices and auction guards bias in their favor, extracting escrow value. `set_fee(2000, attacker)` alone skims 20% of all premiums immediately.
*Fix:* timelock or two-step (announce + commit) on `update_asset`/`set_fee`; allowlist feeds rather than arbitrary admin input.

## MEDIUM

**P-M1. Jupiter Lend integration reads raw byte offsets of a third-party program's account layout.**
`constants.rs:27` (`LENDING_TOKEN_EXCHANGE_PRICE_OFFSET = 115`), `lend.rs:270-276`, `lend.rs:86-90` (token balance at hardcoded offset 64 instead of `TokenAccount::unpack`).
*Scenario:* if Lend ever upgrades its `Lending` account layout, `token_exchange_price` silently reads the wrong 8 bytes. Every pool NAV, deposit share mint, and withdrawal payout is priced off that value — shifted field means shares minted at wildly wrong ratios with no error, just value redistribution to whoever notices first. Owner-check blocks fake accounts but not layout drift.
*Fix:* sanity band (revert outside e.g. `[1e12 … 10e12]`), pin the Lend program version in monitoring; use `spl_token` unpack for the offset-64 read (free correctness).

**P-M2. `unwind_round` lets the plan owner keep the full premium when the oracle fails — adverse selection against makers, and the sampling tolerances make `Failed` epochs realistically frequent.**
`settle.rs:400-422` (unwind returns escrow only, no premium refund), with `constants.rs:44-46`/`55-56` (std: 180 s buckets, 10 s tolerance; quick: 10 s buckets, 2 s tolerance) vs documented devnet feed cadence 61–70 s with 227–320 s gaps (`scripts/init-devnet.ts:20`).
*Scenario:* each std bucket fills only if a genuine Pyth update lands within tolerance after bucket start — with ~70 s cadence vs 10 s window, ~1/7 per bucket; the ≥8-of-10 quorum (`settle.rs:120`) is rare unless Hermes is pushed on demand. Every failure → `Failed` epoch → `unwind_round` → maker gets collateral back but forfeits premium (owner keeps it). A hostile keeper can stop pushing Hermes to systematically unwind makers while owners keep premium.
*Fix:* refund the premium on unwind (fully or net of a time-based slice) — the option never existed. Separately widen `bucket_tolerance_secs` or post multiple candidate updates per bucket.

**P-M3. `withdraw_collateral` shortfall path silently underpays and still clears the pool's receivable.**
`settle.rs:353-355` (`let paid = owed.min(staged)` — shortfall not recorded anywhere), `settle.rs:362-364` (`reserved_usdc/wsol` cleared by the full `owed` via `saturating_sub` even when `paid < owed`).
*Scenario:* plan's Lend position comes up short (Lend bad debt / exchange-price decline / dust-buffer edge). Round marked `Settled`, counterparty permanently short, and pool NAV loses the phantom receivable — LPs absorb it with no accounting trail.
*Fix:* emit a deficit event; keep the residual as a tracked receivable deductible from future close, or revert and require owner top-up. At minimum don't clear the pool reservation by more than `paid`.

**P-M4. LP exit is hard-gated on free funds with no time-bound escape — stuck LPs under stress.**
`pool.rs:245-246` (`require!(value <= free)`).
*Scenario:* `free` excludes `reserved_*` (open-round escrow + post-exercise receivables). If the pool accrues bad positions or unclaimed receivables (keeper stops calling `withdraw_collateral`), `free` can stay below every LP's share value indefinitely — no exit even at a haircut.
*Fix:* keeper-driven sweep that batch-settles matured receivables before withdrawals (cheap, `withdraw_collateral` is permissionless); consider a "withdraw at reserve price with penalty" escape after N days.

**P-M5. Keeper (`agent`) discretion is broad: strike within band, size up to full remaining, premium curve `[floor, 3×floor]`, auction length, plus pool-side lend/unlend control.**
`round.rs:58-198` (all `OpenRoundArgs` agent-chosen subject only to plan bounds and `min_premium_bps_per_day`), `plan.rs:494-535` (`flip_plan` agent-initiated), `pool.rs:296-321` (agent may lend/unlend pool USDC in any amount).
*Scenario:* agent can commit a plan's entire remaining size at the band's worst strike the moment the floor clears the user minimum, churn `rounds_today` up to `max_rounds_per_day` to harvest fee-bearing premium flow to `fee_recipient`, and time `cancel_round` after the pool window opens to shape backstop fills. All "within bounds," but the bounds are loose. Acceptable only while the agent key is honest and single-party.
*Fix:* document as a trusted role; put `rotate_agent` behind the same timelock as admin actions; consider owner co-signing for rounds above a size threshold.

**P-M6. Lend CPI passes several market accounts with no validation, deferring entirely to Jupiter Lend's internal checks.**
`lend.rs:50-62` — only indexes 1, 2, 3, 10, 12 checked; `lending_admin` (0), `reserve` (4), `supply_position` (5), `vault` (7), `claim_account` (8), `liquidity` (9), `rewards_rate_model` (11) are caller-supplied, and in `withdraw_collateral`/`resolve_round` the caller is *anyone*.
*Scenario:* if Lend's own constraints are looser than assumed for any of these (rewards/claim routing), a malicious caller could redirect small value streams or cause unexpected failures. Probably safe today — but an unverified assumption about another program's validation, exactly what audits reject.
*Fix:* validate derivations you can (supply_position = PDA(lending, pool_auth), vault = PDA(market)) or record and check the full market account set once at first use.

## LOW

- **P-L1.** Fee bps applied at take-time, not open-time — admin can raise `fee_bps` between `open_round` and `take_round`. Already a documented known limit; keep it documented.
- **P-L2.** `post_sample` never checks `publish_time <= now` (`settle.rs:75-102`). Theoretical (guardian keys needed to forge), but the check costs nothing.
- **P-L3.** `open_epoch` is permissionless (`settle.rs:18-63`) — rent-funded account-litter spam on any valid schedule. Harmless (canonical seeds, `open_round` re-validates).
- **P-L4.** A paused plan's live auction can still be taken (`round.rs:259-305` has no `plan.paused` check). Owner remedy is `cancel_round`; minor trust wart.
- **P-L5.** Plan accounts are never closed (`plan.rs:330-334` sets `status = Closed` but account + vaults persist, possibly holding sub-`LEND_MIN_REDEEM_VALUE` dust). Consider a final reclaim instruction.
- **P-L6.** Two sources of truth for the pool's Lend position: `pool.rs:150-158` (deposit NAV uses `pool.lend_shares`) vs `pool.rs:234-237` (withdraw uses actual fToken balance). In sync by construction today; fragile.
- **P-L7.** Resolved-exercised rounds linger if `withdraw_collateral` is never called — agent rent locked, phantom receivable in pool NAV. Permissionless, so keeper-dependent only.
- **P-L8.** Systematic floor-rounding biases (`math.rs:63-65` even-count median floors the mean; `math.rs:79-84` `pyth_to_usdc` truncates). ≤1 base unit, direction currently coherent (payer-floor/receiver-ceil).

## Program — checked and found SOLID

- **PDA integrity:** plan `[plan, owner, nonce]`, round `[round, plan, round_index]` (replay-killed by `round_index == plan.round_count`), epoch `[epoch, asset, kind, expiry]`, escrow `[escrow, round]`, `lend_auth` per plan/pool — no collisions; bumps stored at init and enforced on every later use.
- **Escrow lifecycle:** round PDA authority; every exit path (cancel/resolve/unwind) sweeps full balance and closes the account; donation-surplus sweep to plan owner in `cancel_round` (`round.rs:488-505`) correctly closes the previously-identified lock.
- **Signer/ownership checks:** owner-checked plan mutations; agent-checked open/flip; permissionless paths validate every destination via `util::check_token_account` — every `UncheckedAccount` traced, none can misdirect funds.
- **State-machine invariants:** `active_round`/`pending_settlement` gating blocks mid-flight mutations; single-shot status transitions; `resolve` requires epoch `Resolved`, `unwind` requires `Failed` — no double-settle.
- **Arithmetic:** u128 intermediates, `checked_*` everywhere, `overflow-checks = true` in release.
- **Rounding directionality:** deposits `notional_ceil`, payouts `notional_floor`, `LEND_DUST_BUFFER` covers Lend share rounding, `MIN_ROUND_NOTIONAL` keeps settlements above Lend's minimum — over-collateralized absent Lend losses.
- **Pool share math:** virtual-offset first-depositor guard defeats donation/inflation attacks for any practical deposit size.
- **Pool risk caps on take:** premium-vs-notional cap, `max_open_notional`, utilization vs full NAV, spend window, free-funds checks — present and correctly ordered before transfers.
- **Oracle hardening:** feed pinned to `asset.spot_feed`, receiver-owned, `VerificationLevel::Full`, feed-id match, staleness + confidence guards, spot-move guard vs `spot_at_open`; settlement uses permissionless median with ≥8/10 quorum after grace, first-update-per-bucket rule resists cherry-picking.
- **Pause semantics:** global pause halts new risk, never blocks exits — the right shape.
- **Auction math:** monotone Dutch decay with elapsed clamping, `floor ≤ start ≤ 3×floor`, `auction_end < window_start`.

---

# 2. Worker service (`worker/src`, `supabase/`)

## HIGH

**W-H1. Pyth spot staleness is never checked — a failed Hermes fetch re-arms an arbitrarily old spot as fresh.**
`worker/src/pricer/index.ts:28` — `refresh()` on spot failure keeps `spot ?? this.state.get(asset)?.spot` but stamps `refreshedAt: Date.now()`. `quote()` (lines 46–47) only checks `refreshedAt` (25 s) and spot presence, never `spot.publishTime` age.
*Scenario:* Hermes returns errors for 10 minutes (key quota, 5xx). Venues refresh fine, so every quote prices fresh 2026-vol against a 10-minute-old spot. Quick-round floors and maker bids (both derived from `fair`) are systematically off by the spot move; a fast market means the floor sits above true fair and makers' `bidFromStance` clamps produce no bids → rounds go untaken. `get_spot` reports `publish_time`, but nothing gates on it.
*Fix:* in `quote()`, reject (or age-discount) when `now - st.spot.publishTime*1000 > N s` (e.g. 45 s), same as the 30 s quote filter; log the age on refresh failure instead of silently retaining.

**W-H2. One failed pricing permanently blacklists a round from all maker bots.**
`worker/src/makers/index.ts` (`view()`, ~lines 100–112): `seen` caches a `priced:false` RoundView and `view()` returns `null` forever after — `tick()` re-fetches `q` only when the round is absent from `seen`.
*Scenario:* round opens; the 10 s pricer refresh has all four venue fetches fail (or spot missing per W-H1) in the ~2 s window when makers first see the round. Round cached unpriced; bots never re-attempt even after data recovers 10 s later. Std rounds have a 300 s auction → entire auction runs with zero bot participation → cancel → plan stalls, demo shows an empty book. **Single most likely "why did nobody bid" failure.**
*Fix:* don't cache failures — cache only `priced:true` views (or retry while `status === "Auction"` / short failure TTL).

**W-H3. `supabase/reset-and-init.sql` is a live-project footgun: recreates only 2 of 3 migrations.**
Wipes `public` and recreates init + waitlist schemas but omits the `20261006090000_agents` migration (`maker_stances`, `maker_bids`, `intake_runs`; `rounds.asset/auction_secs/pool_delay_secs` columns). Sits in `supabase/` untracked, with a header telling you to run it in the project SQL editor.
*Scenario:* run it against the live project mid-hackathon → `initRepo` (`worker/src/db/index.ts`) probes fail or upserts throw on missing columns → silent MemoryRepo fallback (desk runs/intake/maker P&L invisible to the app, warning only) or a continuous mirror error loop (consecutiveErrors ≥ 5 → `/health` 503 → app shows worker down). Both look like a worker bug and cost debugging time during the freeze window.
*Fix:* delete the file, make it replay all migrations, or add a loud header. Better: replace with `supabase db reset`. **Note: this file was NOT executed during this review.**

## MEDIUM

**W-M1. ITM quick rounds can be recorded `exercised:false` — maker P&L gets the wrong sign.**
`worker/src/loops/mirror.ts` (~lines 44 and 69–73): a Live round that vanishes while its epoch is Resolved is hard-coded `exercised: false` in both the PlanEvent and the `roundOutcomes` fallback. The intended path (observe `Resolved` with `exercised === 2`, then withdrawal closes the account) requires the 15 s mirror to catch the intermediate state — but the keeper ticks every 3 s and resolve_epoch → resolve_round → withdraw_collateral can complete inside one mirror interval (normal case for quick epochs).
*Scenario:* quick put round finishes ITM; keeper resolves and withdraws between mirror ticks; `setMakerBidPnl` computes `makerPnl({exercised:false}) = -premiumPaid` for a round that actually paid the maker intrinsic. Feeds `my_history`/cumulative P&L into maker stance context (`agents/maker/service.ts`) — bots "learn" from a fabricated loss; `recent_outcomes`/exercise-rate stats on the desk are wrong.
*Fix:* when a Live round vanishes on a Resolved epoch, don't guess — fetch the settle price and compare to strike (Pyth historical at expiry), or persist `exercised` from the resolve_round tx the keeper itself sent, or poll mirror faster around quick-epoch expiry.

**W-M2. `GET /desk/runs/:id` has no auth while every sibling route requires the shared secret.**
`worker/src/http/server.ts:154–157`. Mitigated today by the 127.0.0.1 bind, but DEPLOY.md plans Caddy in front — at that point run transcripts (tool traces, plan details, LLM reasoning) become readable unauthenticated while `/intake` and `/desk/preview` stay locked. Easy to copy as a pattern for the next read route.
*Fix:* add the same `secretOk()` guard.

**W-M3. `poolCanTake` ignores USDC parked in Jupiter Lend.**
`worker/src/keeper/plan.ts` (~lines 43–46): the mirror caps spends against `usdcVault − reservedUsdc` raw token balances. Per SPEC §10 idle pool USDC is lent out; if on-chain `pool_take_round` withdraws from Lend to fund a take (or could), the keeper's conservative check says "insufficient free USDC" and it `cancel_round`s an auction the pool could have filled — user loses a fill the program's own accounting allowed.
*Fix:* read the Lend position (or lend-note balance) and add withdrawable principal to free-USDC; if the program genuinely can't pull from Lend mid-take, document that constraint next to the check.

## LOW

- **W-L1.** `clientKey` trusts `X-Client-IP` (`worker/src/http/limits.ts`): once public, a fresh IP-shaped header per request makes the per-IP limiter decorative; global 4/min preview cap still holds — LLM cost is the real exposure. Consider capping the "unknown" bucket or trusting socket peer addr behind the proxy.
- **W-L2.** `/quotes/:asset` unauthenticated and unrate-limited (`server.ts`): each call past the 25 s-stale cache triggers a full 4-venue fetch burst from one unauthenticated GET. Fine localhost; revisit with Caddy.
- **W-L3.** Sampler `posted` array grows unboundedly (`worker/src/keeper/sampler.ts`) — one entry per posted sample, never pruned. Trivial bytes/day, but the one unbounded structure in the file.
- **W-L4.** Failed `post_sample` second tx leaks the VAA rent account (`chain/anchor.ts` `postSample`): close instructions ride in tx B; if B fails (e.g. BucketFilled after a concurrent post), the account created by A is orphaned. Small rent bleed under sustained races.
- **W-L5.** `openRound` mutates the fetched plan (`anchor.ts`: `if (p.roundCount !== a.roundIndex) p.roundCount = a.roundIndex;`): forces a stale index into the ix if the chain moved on — program rejects on-chain, silently masking "stale snapshot" as a program error in logs.
- **W-L6.** `SnapshotCache.invalidate()` vs in-flight read (`chain/snapshot-cache.ts`): an in-flight `snapshot()` started before invalidation can repopulate `last` with pre-invalidation data. 1.5 s TTL bounds the damage; keeper's re-read-before-retry pattern is what actually saves it.
- **W-L7.** Non-retryable program rejections stand all bots down for the round (`makers/index.ts` `RETRY_PROGRAM_ERRORS`): e.g. `SpotMovedTooMuch` permanently adds the round to `attempted`. Deliberate-looking, but combined with W-H2 any single program rejection ends the auction for the bot side.

## Worker — strongest parts

1. **RPC/send robustness** (`chain/rpc.ts`, `chain/send.ts`, keeper `submitOpenRound`): per-request AbortSignal timeouts, single fallback hop, one Connection per loop, send-then-poll-then-resend-the-same-signed-tx confirmer that distinguishes "landed but status unknown" from "nothing landed", plus re-reading the chain before retrying a timed-out `open_round` so a landed tx can't double-open.
2. **LLM containment stack**: priority-laned queue with bounded public backlog (`agents/queue.ts`), `.strict()` zod on every public body, code-side validation that never invents values (intake), thesis grounding + `FORBIDDEN_CONTEXT_KEYS` independence for makers, bound-scrubbed rationale before Risk sees it (`desk/risk/state.ts`), fail-closed when all Risk backends are down. **No path from model output to eval/shell/SQL exists.**
3. **Loop hygiene and test depth**: per-loop error isolation, watchdog, backoff, a `/health` that means something (5 consecutive errors), and ~200 focused tests (1988 lines) pinning the exact edge cases the live system depends on.

---

# 3. Frontend (`app/`)

## HIGH

**A-H1. Default public RPC + aggressive `getProgramAccounts` polling can kill the live demo.**
`app/lib/env.ts:2` falls back to `https://api.devnet.solana.com`; `app/components/maker/maker-board.tsx:111-124` calls `fetchAuctionRounds` (`getProgramAccounts`, `app/lib/bide-client.ts:184-192`) every 4 s per visitor; one failed poll replaces the whole board with the error `EmptyState` (last good rows discarded). App isn't on Vercel yet, so `NEXT_PUBLIC_RPC_URL` is unset in the deploy target until someone remembers it.
*Scenario:* judges open `/maker` (the "anyone can take an auction" showcase), the public endpoint 429s within a minute or two, and the page flips to "Couldn't read auctions from Solana" — exactly the "live URL dead when judges click" hard-drop SPEC §22 warns about.
*Fix:* fail the production build if `NEXT_PUBLIC_RPC_URL` is missing (or bake the Helius URL in Vercel env now); add a `dataSize` filter to `getProgramAccounts`; on poll error keep previous rows with a "stale" badge instead of emptying the list.

**A-H2. A user-entered or intake-applied price is silently overwritten by the preset when the spot feed arrives late.**
`app/components/earn/earn-flow.tsx:141-150`: the effect keyed on `[spot !== null, goal, quick, assetSym, tick]` resets `target` to `presetPrice(...)` whenever spot transitions null → non-null, guarded only by `priceNeeded`. If the user typed a price — or applied an intake result with `target_price_usd` — while the Pyth feed read was pending (a 429'd first fetch retried at the 30 s mark makes this window real; devnet push-feed gaps of 60–300 s are documented), the typed price is replaced by the Balanced preset and the plan is signed at a different strike than the user entered. Contradicts the 2026-10-06 decision-log rule ("no preset fallback; keep the field flagged").
*Fix:* only initialize the preset when `target === null` (or a `userEdited` flag set by `onTargetText`/intake, cleared only on explicit patience click); never overwrite a non-null target on spot arrival.

## MEDIUM

**A-M1. `useTable` has no request cancellation or ordering guard.**
`app/hooks/use-table.ts:33-44`: `load()` fire-and-forget; realtime triggers and the 5–15 s poll can overlap, and a slow earlier response can resolve after a later one, overwriting fresh rows with stale ones (e.g. `/plan/[id]` a round visually flipping back to "auction" after it was taken; `/desk` counts recomputed from stale rows). `setState` also fires after unmount.
*Fix:* alive/token guard inside `load`; ignore out-of-order completions.

**A-M2. Balance check ignores the on-chain dust buffer and fees.**
`app/components/earn/review.tsx:112-114` disables "Start earning" only when `usdcBal < lockWhole` (exact principal). The program transfers `principal + LEND_DUST_BUFFER` (10 extra base units) plus rent/fees (`programs/bide/src/instructions/plan.rs:132-137`). A user depositing exactly the entered amount passes the UI gate and fails at signing with a confusing insufficient-funds error.
*Fix:* require `lockWhole + ~0.01` USDC-side, matching the sell-side `+0.01` already used for SOL.

**A-M3. Epoch lookup on the plan page can attach the wrong settlement samples.**
`app/components/plan/plan-view.tsx:160-167, 223-226`: epochs queried by string-equality on `expiry` (JS `toISOString()` ms precision vs the mirror's timestamptz) and the fallback matches *any* epoch of the right `kind` — if the pubkey match misses, the Samples grid / "Sampling" stage can render another epoch's prices on the page judges will stare at.
*Fix:* query by `epoch_pubkey` from the round row (field exists on `RoundRow`); drop the kind-only fallback.

**A-M4. Blink POST returns a pre-built transaction that can expire, and its inputs are unbounded.**
`app/app/api/actions/plan/route.ts` POST: tx compiled with a blockhash at request time; if approval takes >60–90 s it fails with an opaque error. `target`/`amount` accept any positive number (e.g. `target=1e9`), so a mistyped Blink yields an on-chain `StrikeOffTick`-style rejection surfaced as "Couldn't build the transaction" rather than a clear message.
*Fix:* clamp to a sane tick-snapped band in `parse()`; return the program's error code text on simulation failure.

## LOW

- **A-L1.** `app/lib/tx.ts:100-101` — `/0x1\b/` maps *any* custom-program error index 1 to "Not enough balance", mislabeling unrelated failures.
- **A-L2.** `app/components/plan/my-plans.tsx:84` vs `plan-view.tsx:233-236` — the two components disagree on which strike field is authoritative for sell plans (`target_strike` vs `exit_strike`). Today `buildDraft` sets both so nothing breaks; if the mirror ever zeroes `target_strike` for sells, `/plans` shows "Sell X SOL at $0".
- **A-L3.** `app/app/api/_lib/guard.ts:60-68` — `x-real-ip` trust is Vercel-specific; on any other host it's client-spoofable, bypassing the worker's per-IP rate limit (documented in-code).
- **A-L4.** `app/app/api/waitlist/route.ts` — no rate limit; unlimited anon inserts (spam vector into Supabase).
- **A-L5.** `app/components/pool/pool-panel.tsx:47` — withdraw parses shares with hardcoded 6 decimals; verify against the share mint's actual decimals.
- **A-L6.** `app/components/plan/plan-view.tsx:207` — `getAccountInfo(...).then(...)` has no `.catch` (unhandled rejection on RPC error; Lend interest silently stays "—").
- **A-L7.** `app/components/earn/review.tsx:51-70` — desk preview runs once on mount with `publicKey` possibly unset so `owner` is omitted; StrictMode double-fires it in dev (two LLM preview calls per review).
- **A-L8.** `app/components/maker/maker-board.tsx:66,94` — "Take at $X" derived from the client clock; with device skew the charged on-chain price can differ (worth an "indicative" caption).
- **A-L9.** `app/hooks/use-token-balance.ts` — no polling and no refresh key used in `review.tsx`; balance shown can be stale if funds arrive after mount.

## Frontend — strongest parts

1. **Public-route input hardening** (`app/app/api/_lib/guard.ts`): own-keys-only field iteration (proto-poisoning safe), strict u64/enum/regex validators, unknown-key rejection, control-character scrubbing for intake text, correct last-hop XFF handling — with the worker re-validating authoritatively. Unusually careful for a 36-hour build.
2. **Money math discipline** (`app/lib/plan-math.ts`, `app/lib/format.ts`): all transaction amounts in bigint with explicit base-unit conversion, rounding directions matching the program's tick/bounds checks (snap down for buys, up for sells), `notionalUp/Down` ceil/floor split, consistent after-fee display.
3. **No white-screens**: every async path traced has a bounded terminal state — `useDeskPreview` give-up/misses/404 handling, `explainTxError` mapping program error codes to plain English, `EmptyState`/skeleton fallbacks on every table, worker-offline banner, `useNow` starting at 0 to avoid hydration mismatches.

---

# Triage order

**Hackathon-demo blockers (do first):**
1. W-H2 — stop caching unpriced rounds (one-line-ish fix, most likely empty-book cause).
2. W-H1 — gate quotes on `spot.publishTime` age.
3. A-H1 — set `NEXT_PUBLIC_RPC_URL` in the deploy target now; keep last-good rows on poll error.
4. A-H2 — never overwrite a non-null user target on spot arrival (also honors the 2026-10-06 decision).
5. W-H3 — delete or fix `reset-and-init.sql` before anyone "helpfully" runs it.
6. W-M1 — maker P&L sign on quick rounds (wrong-number-in-demo risk).

**Mainnet gates (before any real TVL):**
1. P-H1 — atomic deploy + init (front-run).
2. P-H2 — multisig upgrade + pool authority.
3. P-H3 — timelock/allowlist on admin oracle + fee changes.
4. P-M2 — premium refund on unwind (also neutralizes the feed-gap griefing).
5. P-M1 + P-M3 — Lend layout sanity bounds; honest shortfall accounting.

**Hardening backlog:** the MEDIUMs and LOWs above, roughly in listed order.

**Natural next gates after fixes:** scanner pass (Sec3/X-ray style) for mechanical confirmation → formal audit → devnet soak with re-measured sample tolerances (P-M2) against real feed cadence.
