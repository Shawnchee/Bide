# fable.md — Adversarial review (round 3): program, off-chain, economics, UI/UX

Date: 2026-10-07. Reviewer: Claude Fable 5.1 with four parallel adversarial passes (program, off-chain, mechanism/economics, UI/UX) and an independent re-read of the core program. Fixes applied in this session were made by Opus 5.5 agents and verified here.

Scope: `programs/bide/src/**`, `tests/src/**`, `worker/**`, `app/**`, `packages/shared/**`, `supabase/**`, `scripts/**`, deploy files, SPEC/ARCHITECTURE/HACKATHON. Prior reviews (`z_review.md`, `z_v2_review.md`, `codex_v2.md`) were read for their claims only; every claim below was re-derived from code. Nothing here is an audit or a certification.

Severity: Critical = principal loss without consent · High = headline claim false, or operator/attacker can take a large share of user or LP value, or a demo-killer · Medium = material leak, cap bypass, liveness freeze · Low · Info.

---

## 0. Verdict

1. **No third-party path to user, maker, LP or keeper funds** was found in the program or the off-chain code. Signer gating, destination checks, canonical vaults, Pyth pinning, rounding direction and the round state machine all hold. The two prior reviews' "solid" claims are confirmed with the refinements in §6.
2. **Two real bugs from `codex_v2.md` are confirmed and fixed in this session** (§1): pool share minting against a stale NAV (P1, tested: an attacker made +5.07 USDC on a 500 USDC deposit before the fix, −2 base units after) and the Sell-plan WSOL wrap short by 10 lamports (P2).
3. **One deployment footgun is fixed** (§1, O-M1): the pm2 env parser kept inline `#` comments, so a worker env file written from the `DEPLOY.md` template would have made the shared secret a public string or appended a comment to it.
4. **The biggest remaining gap is between the spec and the chain**: the "CEX-anchored on-chain floor" that SPEC §6 and §22 advertise does not exist. `open_round` accepts any floor above zero. The user's signed minimum yield is the only on-chain price protection and it is weak for daily rounds and nearly absent for quick rounds (§3, E-H2).
5. **The worst new attacker-profitable issue is off-chain liveness** (§4, O-H1): `open_epoch` is permissionless and the worker reads every epoch/plan/round with an unfiltered `getProgramAccounts`. Around 26k free devnet epoch accounts stall keeper, sampler, makers and mirror together, and with the accepted "owner keeps premium on unwind" rule that is profitable.
6. **The UI is honest and disciplined** (§5) but five cheap fixes decide the pitch: public RPC fallback shows "program isn't on devnet yet" on a 429, the "Why this?" sheet on a live round opens the wrong desk run (so the on-chain memo story shows "No fingerprint"), the hero line says "a limit order that pays you", the review card says "You get $X now", and the landing never mentions the AI desk or the program overruling it.

---

## 1. Fixed in this session (uncommitted, not deployed)

| ID | Sev | What | Files | Verification |
|---|---|---|---|---|
| P1 | High (LP) | Pool NAV marked live option legs at spot only. Between `resolve_epoch` (outcome public) and permissionless `resolve_round` (books the strike receivable), anyone could `pool_deposit`, then resolve and `pool_withdraw` at the higher NAV. Also exploitable whenever a pool option is in the money. **Fix:** four running sums on `Pool` (`put_open_size`, `put_open_notional`, `call_open_notional`, `call_open_size`), updated in `pool_take_round` and `release_pool`; `pool_nav` marks each leg at intrinsic value `max(spot leg, strike leg)`; receivables at face/spot. `pool_take_round` now requires the SOL asset for puts **and** calls (also closes M-1 below). New admin-only one-shot `migrate_pool` grows the devnet pool account 148 → 180 bytes in place. | `programs/bide/src/{state.rs,lib.rs,instructions/{pool.rs,round.rs,settle.rs}}`, `packages/shared/src/{client.ts,idl/*}`, `tests/src/codex-v2.test.ts` (new; replaces the untracked repro), `SPEC.md` decision log, `BUILD.md` | Before fix (old `.so`): attacker +5,072,526 base units on the exercised-put case, +7,753,280 on the call case. After: −2 (rounding). LiteSVM suite 43/43, `cargo test -p bide` 12/12 (6 new NAV unit tests), typecheck clean. **Deploy order matters:** upgrade program, then call `migrate_pool` immediately; until then every pool instruction fails to deserialize. |
| P2 | High (UX) | Sell plan on SOL wrapped exactly `size` lamports, but `create_plan` pulls `size + LEND_DUST_BUFFER` (10). Default flow failed with an empty WSOL account. **Fix:** `Draft.depositAmount` = lock + buffer when the collateral has a Lend market; `tx.ts` wraps that; balance precheck uses it; review card shows the buffer in plain words ("Plus a tiny 0.00001 USDC extra … You get it back when the plan ends"). Blink route inherits the fix via `buildDraft`. | `app/lib/{plan-math.ts,tx.ts}`, `app/components/earn/review.tsx`, `packages/shared/src/client.ts` (comment) | `tsc` and eslint clean; `buildDraft` checked by script (sell 1 SOL → deposit 1,000,000,010). Not sent on devnet. |
| O-M1 | Medium | `worker/ecosystem.config.cjs` env parser kept everything after `=`, including inline `# comments` and trailing spaces. `DEPLOY.md` §3 template has comments on the secret lines. **Fix:** parser now trims, honours quotes, and strips ` # …` on unquoted values. | `worker/ecosystem.config.cjs` | Tested against a copy of the template: `WORKER_SHARED_SECRET` → `""`, `A=abc  # c` → `abc`, `B="x # y"` → `x # y`. **Action:** check `/etc/bide/worker.env` on the VM; if it was written from the template, the secret may have been wrong (app calls 401) or contain the comment. Rotate it. |

Residual limits of the P1 fix, written into `pool.rs` comments and SPEC: the max is over per-kind sums, not per round (slightly low with mixed strikes, never below the old mark); time value ignored; mark uses spot not settle price, so NAV can be overstated by at most |spot − strike| × size in the short window before `resolve_round`; a pool with live rounds at migration time falls back to the old mark for those rounds (the devnet pool had no takes). Two pre-existing issues the fix agent noticed and did not touch: the last LP's 100 % withdrawal fails once NAV per share < 1 because of the virtual offset (gap ≤ ~1,000 base units), and the keeper's `poolCanTake` double-counts escrow (too conservative).

---

## 2. Program (Solana, Anchor)

No Critical or High theft path. Three Mediums the prior reviews missed, seven Lows, five Infos.

### M-1 — Medium — Pool call rounds on a non-SOL asset bypassed the utilisation cap and stranded delivered tokens. **Closed by the P1 fix.**
`pool_take_round` valued the pool's WSOL at the *round asset's* spot (comment said "SOL spot") and the WSOL-only guard applied to puts only. For a Call on a future tBTC asset, WSOL would be valued at the BTC price (~500× overvalued), the `max_utilization_bps` check always passed, `release_pool` booked `reserved_wsol += size` in tBTC units, and the delivered tBTC landed in an ATA that `pool_withdraw` never pays out. Latent today (SOL only). The guard is now unconditional.

### M-2 — Medium — Permissionless `pool_take_round` against a floor fixed up to 30 min earlier is a free option for the plan owner against LPs
`round.rs` `pool_take_round`: anyone may call in `[pool_open, pool_open + 60 s]`; the pool pays `premium_floor` computed at `open_round`; the only staleness guard is `max_spot_move_bps` (devnet 50 bps). The owner calls it only when the option is now worth more than the floor, and lets the round cancel otherwise. Bounded by pool caps (devnet: 2 USDC/day spend window, 150 bps of notional, 40 USDC open), so bleed, not drain. **Fix:** gate on `config.agent` (the keeper already decides), or an agent-signed fresh floor at pool-take time, or a pool haircut.

### M-3 — Medium — No exit from a plan or a pending settlement that does not go through a successful Jupiter Lend CPI
`withdraw_collateral` (`settle.rs`) and `drain_plan` (`plan.rs`) both require a Lend withdraw/redeem to succeed; `pending_settlement` blocks `close_plan`, `expire_plan`, `update_plan` and `open_round`. If Lend's USDC or WSOL market pauses or changes interface, every Buy plan freezes and every exercised put is stuck one-sided: the maker's SOL is already delivered to the owner, the maker's USDC unpaid, until Lend resumes. Prior P-M4 covered only LP exits. **Fix:** an owner-callable (permissionless after N days) `settle_in_f_tokens` that transfers `ceil(owed / exchange_price)` fTokens to the counterparty's fToken account and clears `pending_settlement`; and a `close_plan_raw` handing fTokens to the owner. Both need only SPL transfers signed by `lend_auth`.

### Lows
- **L-1** Pool NAV uses a Lend exchange price that only refreshes inside a Lend op; between pool Lend ops `lend_value` lags accrued interest (depositors slightly favoured over withdrawers, bps). Pass the market accounts and call `update_rate` before `pool_nav`, or document.
- **L-2** `pool_deposit` prices WSOL at a push-feed spot up to `max_spot_age_secs` old (devnet 300 s): deposit after a CEX drop the feed has not seen, dilute other LPs. Keep ≤ 30 s on mainnet; consider USDC-only deposits or a deposit fee.
- **L-3** `take_round` ignores `asset.enabled` and `plan.paused` (only `cfg.paused`). An admin-disabled asset or an owner-paused plan can still be filled mid-auction. Add both checks to `take_round` and `pool_take_round`.
- **L-4** `flip_plan` is agent-only: a dead keeper strands a fully filled Wheel plan with un-lent SOL in the asset vault. ARCHITECTURE's "no state depends on the keeper staying alive" is false for Wheel. Allow `plan.owner` as alternative signer.
- **L-5** Epoch accounts are never closed; quick epochs lock ~0.2 SOL/day of keeper rent permanently, and `open_epoch` is permissionless (see O-H1). Add `close_epoch` after `expiry + grace + 7 d`, refunding a stored payer (layout change).
- **L-6** Owner can grief the keeper's desk budget: `max_rounds_per_day` up to 255 and instant `cancel_round` after each open burns a full Quant + Risk run per cancel. Back off per plan off-chain; cap `max_rounds_per_day` on-chain.
- **L-7** `update_plan` reverts when the required top-up is below Lend's minimum operate amount (1,000 units): a one-tick strike raise on a small plan fails with `OperateAmountsNearlyZero`. Transfer tiny top-ups into the vault without the Lend deposit.

### Infos
`Asset.lend_f_token_mint` is written, never read (every path uses the static `lend::f_token_for_mint`). fToken donations split deposit-NAV (`pool.lend_shares`) from withdraw-NAV (`pool_f_token.amount`); donor always loses, so not an attack, but use one source. All devnet addresses are compile-time constants; the mainnet build is a separate artifact to review. `Config.paused` does not block `pool_deposit`. `spend_window_secs = 0` makes `spend_window_cap` bound a single take; require > 0 in `init_pool`/`set_pool_params`.

### Re-verified solid
Pyth: receiver owner pin, `VerificationLevel::Full`, feed id, pinned push-feed address, age, confidence, `publish_time ≤ now`. The bucket rule `prev_publish_time < bucket_start ≤ publish_time` selects exactly one print per bucket even when Pythnet aggregates share a second. Omitted buckets can be back-filled from the Hermes archive by anyone during grace. Escrow lifecycle and sweeps; replay killed by `round_index == plan.round_count`; user locks `notional_ceil`, is debited `notional_floor`; `LEND_DUST_BUFFER` covers share rounding; Lend program, liquidity program, fToken mint and lending account pinned; Token-2022 excluded everywhere; no re-entrancy; no loops over rounds.

### Test gaps worth closing
Any pool Call round; any second asset (no-Lend, non-9-decimals); a full std epoch loop; median bias with exactly 8 samples; owner-timed `pool_take_round` at the tolerance edge; `pool_withdraw` with reserves and accrued yield; Lend failure injection; exits under global pause; `update_plan` after a partial fill; `take_round` with `asset.enabled = false`; arithmetic edges (`pyth_to_usdc` positive exponent, `min_premium_bps_per_day = u16::MAX`, `auction_price` with `now < auction_start`).

---

## 3. Mechanism and economics

Property worth pitching first: **a wrong settlement price can only move value from the option buyer (maker or pool) to the plan owner, never the reverse.** A put buyer wants exercise exactly when `S < K` is true; the seller wants it when it is false. So repointing the feed, omitting samples or a bad bucket cannot extract the user's principal. The user's only principal exposure is the swap at their own K, which they signed, plus program-upgrade risk.

### E-H1 — High (pitch honesty) — The two "competing" makers are one party
Both keypairs load from one env file into one Node process; both price from the same `fair`; the process ranks the two bids and sends **one** `take_round`; LLM bids are clamped to `[floor, min(start, fair)]` (`agents/maker/stance.ts`), so no in-house maker ever pays above fair and the 1.3×fair → fair part of the Dutch curve never clears. Realised price sits in `[floor, fair]`. Bids and stances are written to anon-readable Supabase tables **at decision time**, before the take, so an outside maker can read the in-house wall. README's "the other side is mostly us" is right; SPEC/pitch "two competing AI makers" overstates. **Fix:** say "our two makers are a reserve-price generator; real competition needs outside makers"; delay publishing bids until the round is taken or cancelled.

### E-H2 — High — The CEX-anchored floor is an operator oracle, not an on-chain protection
`open_round` checks only `floor > 0`, `floor ≤ start ≤ 3·floor`, and `premium_meets_min` (user minimum, linear in time). The program never sees fair or CEX data. The user minimum scales with T while option value scales with √T, so:

| 500 USDC put, SOL ≈ $121, IV 50 %, 10 bps/day default, 10 % fee | BS fair | On-chain min | min / fair |
|---|---|---|---|
| Weekly, 5 % OTM | ≈ $4.70 | $3.89 | 83 % |
| 1-day, ≈ ATM | ≈ $3.40 | $0.56 | 16 % |
| Quick 10-min, ≈ ATM | ≈ $0.44 | $0.004 | 0.9 % |

A compromised or malicious agent key can sell the user's options to its own maker at the signed minimum every eligible round. Agent-only levers the program ignores: `auction_secs` down to 10 s std / 5 s quick (shuts out outside makers), size down to 1 USDC notional, which eligible epoch, skipping forever. **Fix, cheapest first:** state it plainly in the trust section; make the minimum scale with √days or raise quick defaults; write `premium_fair` into `Round` at open so the tape shows paid/fair; long-term, a second signer attesting the CEX median or a program-computed intrinsic-plus-min-IV floor from Pyth spot.

### E-H3 — High (LP trust) — Pool caps are unbounded and the operator can route LP money to its own plan
`set_pool_params` bounds only utilisation ≤ 100 %; `max_premium_bps_of_notional`, `max_open_notional`, `spend_window_cap` are free. With agent-set floors and permissionless `pool_take_round`, the operator opens a plan as a user, sets the floor at the cap, has both makers pass, and the pool buys at the floor round after round. Today the only LP is the deployer. Before any outside LP: cap the caps in code (premium ≤ 20 % of notional, spend window ≤ x % of NAV/day), multisig the pool authority, show paid/fair on the tape.

### Mediums
- **E-M1** Sole-poster sample omission: with ≥ 8 of 10 accepted after grace, the only practical poster (the keeper) can drop the two most extreme samples on one side, shifting the median ~0.1–0.2 %. Helps sellers, hurts buyers (consistent with the property above). Quick-epoch grace of 120 s is too short for an outsider to react.
- **E-M2** Lend shortfall on exercise is silently borne by the maker/pool (`paid = min(owed, staged)`) and the pool receivable is still cleared by `owed`. The user is shielded on the exercise path but bears Lend risk on the not-exercised path. Unpriced asymmetry; disclose or pay the deficit from the plan's remaining yield first.
- **E-M3** The pool is adversely selected by construction: it fills only after every maker declined at the floor, so it fills when floor > fair. Observed: 3 of 4 post-fix quick rounds went to the pool while both makers logged "fair below the auction floor". SPEC §10 "buys below fair value" is wrong; the `/pool` copy ("expect to lose money on average") is right.
- **E-M4** Pool NAV ignores open-option time value and had no exit lock: an LP can withdraw before a scheduled bad fill and re-deposit after. The intrinsic-value mark from P1 removes the stale-outcome capture; the front-run of a known-bad fill remains until there is a deposit/withdraw fee or short lock.
- **E-M5** Deposit and withdraw at a stale push-feed spot (≤ 300 s devnet) is free oracle arbitrage against LPs, ~1 % × non-SOL share of NAV per cycle after a 1 % move. Small on mainnet at 30 s; a fee or lock closes it.
- **E-M6** UI premium range tops at `start` after fee, which in-house makers never pay. Show floor–fair, or floor only.

### Spec-vs-code drift (fix the docs before the demo)
SPEC §6 "program rejects any fill below the CEX floor" and §22 "CEX-anchored on-chain floor" are false (E-H2). SPEC §10 "pool buys below fair" is false (E-M3). SPEC §9b "the keeper calls `pool_take_round`" omits that it is permissionless. The pricer lowers start to 3·floor and raises floor to fair/3 when needed, documented in ARCHITECTURE but not SPEC. §5 "USDC comes back automatically" holds only for the deadline path; a **filled** plan keeps yield and dust in the vault until the owner clicks "Close & withdraw". The strike-nudge band feature is dead in the product (app always sends `lockStrike: true`) while the Quant prompt still describes it.

### Fees
Cap 20 %, admin-settable instantly, no timelock. Charged at take with the then-current fee, so an admin raising the fee between open and take can push the user's net below their signed minimum by up to 10 points. LPs pay the fee on backstop fills. Devnet `fee_recipient` is the demo-user wallet, so the demo wallet's "earned" line includes Bide's fee.

### Yield accounting
Verified on every path: not exercised, exercised, cancelled, unwound, expired, wheel flip. "You earn both premium and Lend yield" is true for SOL plans on principal, ≈ $0 on devnet, as README says. tBTC has no Lend market (disclosed).

### Trust statement (what judges will ask)
Principal cannot be moved by the operator without the program upgrade key; it can only leave as a swap at the user's own K or through a Lend loss. The operator can sell every eligible round at the user's signed minimum to itself, open nothing so the user earns only Lend yield, and take up to 20 % of premium. With the upgrade key, everything. Honest one-liner: *"Your principal is protected by the program and your signed limits. The price you get per round is protected only by your signed minimum, which is weak for short rounds. The oracle cannot be used against you, only against the makers."*

---

## 4. Off-chain (worker, app API, Supabase, deploy)

Secrets hygiene is clean: nothing secret tracked, `keys/` 700/600, `.env` files 600 and ignored, no key material in untracked files, no postinstall scripts, service key worker-only, no server env in client bundles, no SSRF, no SQL interpolation, constant-time fail-closed shared secret.

### O-H1 — High (demo-killer, attacker-profitable) — Permissionless `open_epoch` + unfiltered full-table reads
`worker/src/chain/anchor.ts` reads `plan.all()`, `round.all()`, `epoch.all()` with 20–30 s timeouts; the keeper iterates every epoch each tick; the mirror upserts every row every 15 s. `open_epoch` needs only a payer. Quick expiries every 600 s over 180 days give ~26k valid epoch PDAs per asset at ~0.002 SOL each (free on devnet, ~50 SOL on mainnet). Effect: every snapshot times out, keeper/makers/mirror/sampler throw every tick, `/health` 503, no new Live rounds sampled, epochs fail, rounds unwind. Combined with the accepted "owner keeps premium on unwind": collect a premium, spam epochs, keep it. Recovery needs code changes because epochs are never closed. **Fix:** derive the epoch PDAs the keeper cares about and `getMultipleAccounts` them; `getProgramAccounts` with `dataSize` + `memcmp` on status for rounds and plans (the app already does this); hard-cap result counts; mirror only changed rows. On-chain: gate `open_epoch` to the agent or add `close_epoch`.

### O-M2 — Medium — Unauthenticated, unlimited endpoints share one event loop with the 1-second sampler
Worker `GET /quotes/:asset` (reprices every cached venue quote per call, triggers a venue refresh when > 25 s old), `/health`, and the app relays `/api/quotes`, `/api/desk/runs/[id]`, `/api/intake/[id]`, `/api/health` have no limiter; the Blink `POST /api/actions/plan` costs ~5 Helius calls per anonymous request on the same key the keeper uses. A few hundred req/s from Vercel's horizontally scaled relay keeps the single Node thread in `buildSmiles` while the sampler needs it inside a 60 s quick window. Plausible, not benchmarked. **Fix:** `SlidingLimiter` (already in `http/limits.ts`) on those routes, 5–10 s memo on `/quotes`, `Cache-Control: s-maxage=5` on the app quotes route, separate RPC key or limiter for the Blink POST.

### O-M3 — Medium — Pricer has no IV sanity band; with two venues the median is a mean; makers take at any fair
Venue parsers accept any positive finite IV; `filterQuotes` drops only spreads > 10 vol points, so bid = ask = 500 % IV passes. With exactly two venues, one garbage venue moves fair by half. The desk copies the resulting floor/start, Risk has no numeric bound, the program only checks `start ≤ 3·floor` and the user min, and the maker bots bid up to fair with no premium-to-notional cap (the pool is capped on-chain; the bots are not). Loss bounded by maker inventory. **Fix:** drop IV outside `[0.05, 4.0]`; with two venues require `|iv1 − iv2| ≤ 0.15` or use the lower; clamp fair ≤ k × notional; add a premium cap in `makerDecide`.

### O-M4 — Low/Medium — Unsigned drafts are published world-readable
Desk preview runs store the visitor's wallet, strike, size and horizon in `desk_runs.memo` (anon SELECT + realtime). Anyone subscribed sees every draft, including ones never signed. Strip or hash `owner` in previews, or serve them only by id.

### Lows
`Caddyfile.example` has no `/intake` route (404) and exposes `/quotes`, `/health` without `rate_limit`. Unbounded in-memory sets (`sampler.posted`, keeper `backoff`/`deskDone`/`poolGaveUp`, `makers.attempted`). Scheduler overrun lets `Makers.tick` overlap itself → duplicate `take_round` (second fails, fee burned). Wall-clock dependence on a 60 s quick window with no NTP step in DEPLOY (`timedatectl set-ntp true`). Waitlist has no limiter and `duplicate: true` enumerates emails. Blink: fractional `days`, `amount ≥ 1e21` → 500, success message omits the amount; prior A-M4 still open. `price_grid` array sizes uncapped in code (schema `maxItems` is advisory to the model). `/health` returns env SET/EMPTY and RPC error strings publicly. Hermes accumulator parser has no length guards. `reset-and-init.sql` default-grants SELECT to anon on future tables (RLS still blocks, footgun if a table is created without RLS) and is still a `drop schema public cascade`.

### Blast radius of a VM compromise (documented posture, for the trust section)
Keeper key = `Config.agent`: worst-allowed rounds within user bounds, flips, pool lend/unlend; cannot move collateral. Maker keys: their own USDC/WSOL. Supabase **service** key: rewrite every table the app shows judges, read intake text and waitlist emails. It is the only key that can falsify what the app displays.

### Still open from z_review
W-L3, W-L4, W-L5, A-L4, A-M4.

---

## 5. UI/UX (app ran live: /, /earn + review, /desk, /auctions, /plan live and closed, /maker, /pool, /plans; dark and light; zero console errors or hydration warnings; 390 px pass was code-only)

### What is genuinely good
The ⚠️ "Checked once at 08:00 UTC on each round's end date, not on touch. If SOL crashes to $80, you still buy at $113.80" box is present, correct, computed, and before the signature. No options vocabulary in the earn flow. Every pay figure is after fee and says so; no APY on premiums; no "guaranteed". One real signature (one v0 tx: wrap + create_plan). Honest worker-offline, stale and unconfigured states. `/plan` and `/desk` (Pyth 10-sample grid with median, both AI buyers' bids and theses, tool traces, "Times Solana rejected the AI" counter) are a better verifiable-AI story than most decks. Visual system is disciplined: Inter, tabular numbers, one accent, both themes complete, no AI-slop tells.

### High
- **U-A1** Hero subtitle "A limit order that pays you while it waits" (`app/app/page.tsx:52`, layout meta) is the framing SPEC §5 forbids; it contradicts step 3 below it. Use "Same price as a limit order, different trigger — and it pays you every round while it waits."
- **U-A2** "You get $X now" / "Paid every round, filled or not" (`review.tsx`, `earn-flow.tsx`, `page.tsx`) overclaim: the tape shows "No buyer" and cancelled rounds. Use "about $X for round one, paid when a buyer takes it (the backstop pool bids at the floor if nobody else does)" and "Paid every round a buyer takes."
- **U-B1** A closed/ended plan still shows "Waiting for the first round… Next round opens within 10 minutes" (`plan-view.tsx:426`, seen live). Branch on status and horizon.
- **U-B2** "Why this?" on a live round opens the newest desk run, which is deciding the **next** round, so the sheet shows "—" and "No fingerprint" (`plan-view.tsx:268`, seen live). This is the on-chain memo moment of the pitch. Match runs by `memo_hash` / `tx_sig` and show "memo 0x… · matches on-chain ✓" inline on the round card.
- **U-B3** `NEXT_PUBLIC_RPC_URL` is unset, so the browser uses public devnet RPC; a 429 makes `use-program` report "missing" → "Start earning" disabled and "program isn't on devnet yet" on `/maker`. Set the Helius URL in `.env.local` and Vercel; add an "unreachable, retrying" state.
- **U-E1** The landing never mentions the AI desk, the program overruling it, or the on-chain memo hash; the comparison table that carries "AI with on-chain guardrails" is collapsed. Add a fourth step with the live rejection counter and open the table on ≥ lg.

### Medium
`dateShort` is local time while `dateTimeUtc` is UTC on the same cards (`format.ts:71`): in Singapore a 23:50 UTC round shows a different date two lines apart; give `dateShort` `timeZone: "UTC"`. Balance check ignores SOL rent on buy plans (require ~0.03 SOL both sides). Desk preview says "About a minute" but runs 50–240 s; add "You can start now; the first price appears when the round opens." Sub-cent numbers everywhere (`$0.0007`) plus a stray `usd4` formatter; unify and demo with a plan whose pay is in cents. "Resolved" raw status and raw maker address on `/plan` vs "Not filled" / "AI buyer 1" on `/auctions`; reuse the tape's helpers. "Clef", "GLM", "memo 0x…" leak into the earn flow footer; render "Pricing AI" / "Risk AI" there. No confirm on "Close & withdraw". `use-table` has no request ordering or abort (rows can flip backwards). Hero card is an infinite skeleton on RPC error. Wrong-network wallets get a generic failure; say "Set your wallet to Solana Devnet first." Swap-input focus ring nearly invisible in dark. Devnet badge hidden below `sm`. Tab roles without `aria-controls`.

### Low / nits
Invalid price input leaves the previous target live. `nonce` regenerates on every 30 s tick, so a retry after the 60 s confirm timeout creates a second plan. Clipboard writes unhandled. Pool panel assumes 6-dp shares, no balance validation. "My plans" highlighted on someone else's `/plan`. "(1 steps)". Payoff-slider labels may touch at 358 px; date input orphaned under `sm`.

### Demo risks
Public RPC 429 (U-B3). Empty "Why this?" (U-B2). A quick round's full life (~12 min) cannot be shown in a 3-minute walkthrough: have an active quick plan mid-round before the judge arrives and open `/plan/<id>` and `/auctions` history rather than creating a plan live; `/maker` is empty between windows. Pre-run the desk preview. Record with a daily-round plan so pay is in cents. Demo from the Vercel URL, not localhost (Phantom flags it). Clear `localStorage.theme` on the demo laptop so the recording is dark.

---

## 6. Prior-review claims corrected
- z_v2 "zero new high-confidence vulnerabilities" was defensible for third-party theft but not for LP expectancy (M-2, E-H3), third-party liveness (M-3), off-chain liveness (O-H1), or the pool NAV capture (P1, found by codex_v2 and confirmed here).
- The `round.rs` comment "NAV uses SOL spot" was wrong for non-SOL calls (M-1, now fixed).
- ARCHITECTURE "no state depends on the keeper staying alive" is false for Wheel plans (`flip_plan`) and pool call liveness (`pool_unlend` is agent/authority-only).
- z_review P-L3 called permissionless `open_epoch` "harmless"; with the worker's unfiltered reads it is the cheapest full-system DoS (O-H1).

---

## 7. Ordered to-do

**Before the demo (hours, mostly copy and config)**
1. Deploy the P1 program + `migrate_pool` together; redeploy the app with P2; check the VM env file and rotate the shared secret if it came from the template (O-M1).
2. Set `NEXT_PUBLIC_RPC_URL` and add the "unreachable" state (U-B3).
3. Fix `latestRun` selection and show "matches on-chain ✓" on the round card (U-B2).
4. Hero line, "now / every round" copy, landing AI step (U-A1, U-A2, U-E1).
5. Closed-plan state, `dateShort` UTC, premium range floor–fair (U-B1, E-M6).
6. Fix SPEC §6/§22/§10/§9b wording; add the oracle-direction property and the trust one-liner to README "Honest limits".
7. Filtered account reads in the worker (O-H1). One afternoon, and it protects against ordinary growth too.

**Before any outside LP or real user (mainnet gates)**
Bound `set_pool_params` in code and multisig the pool authority and upgrade key (E-H3); gate or re-quote `pool_take_round` (M-2); fToken escape hatch for Lend outages (M-3); user minimum scaling with √T or higher quick defaults, and `premium_fair` stored in `Round` (E-H2); pool deposit/withdraw fee or lock (E-M4, E-M5); IV band, two-venue agreement and maker premium cap (O-M3); limiters on public routes (O-M2); timelock `update_asset`/`set_fee`; decide the shortfall rule (E-M2); refund premium on unwind; `close_epoch` or agent-gated `open_epoch`; delay publishing maker bids until the take (E-H1).

## 8. Checks run in this session
- LiteSVM program suite: 43 tests, 43 pass, 0 fail. `cargo test -p bide`: 12 passed, 0 failed. Worker `node:test` suite: 206 tests, 206 pass, 0 fail. All run after the P1, P2 and O-M1 changes.
- App `tsc --noEmit` and eslint: clean after P2.
- `ecosystem.config.cjs` parser: tested against a copy of the DEPLOY template (scratchpad only).
- Nothing was sent to devnet; nothing was committed.
