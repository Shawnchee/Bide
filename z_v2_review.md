# z_v2_review — Adversarial Security Review (round 2)

Date: 2026-10-07
Scope: full production codebase (the branch diff contained only docs, so the review target was all code): `programs/bide/src/**` including all `instructions/`, `worker/src/**`, `app/**` server routes and libs, `supabase/migrations/**` + `reset-and-init.sql`.
Method: one vulnerability-identification pass over every trust boundary (program ↔ caller, app ↔ worker, worker ↔ chain/Supabase), tracing concrete attack paths for account substitution, signer bypass, oracle manipulation, value-math abuse, replay, HTTP auth bypass, injection, and RLS gaps. Findings were held to a >80% exploitability bar before being reported.

## Verdict

**Zero new high-confidence vulnerabilities.** No finding survived the exploitability bar. The two actionable gaps from round 1 (`z_review.md`) are confirmed fixed in code. The remaining risk register is unchanged — it consists of deployment-posture and honest-accounting items already documented and accepted in `z_review.md`, not newly exploitable bugs.

## Fixes confirmed since z_review.md

| Prior ID | Issue | Status |
|---|---|---|
| — (post_sample) | Settle samples could be dated in the future / not first-per-bucket / not fully guardian-verified | Fixed — `settle.rs` requires `VerificationLevel::Full`, receiver-owner pin, first-update-per-bucket, and `publish_time <= now` before accepting any sample |
| W-M2 | `GET /desk/runs/:id` on the worker lacked the shared-secret check | Fixed — every endpoint that reads or writes run data, including this one, now fails closed on the shared secret (`timingSafeEqual`) |

## What was verified as solid (independent re-confirmation, not new findings)

- **Program signer/authority model** — agent-gated `open_round`/`flip_plan`/pool lend via `config.agent == signer`; admin-gated config/asset/pool-param changes via `has_one = admin`; owner-gated plan mutations via `has_one = owner`. Every permissionless path (`resolve_epoch`, `resolve_round`, `withdraw_collateral`, `unwind_round`, `cancel_round`, `post_sample`, `expire_plan`) validates each destination token account (mint + owner check, canonical-ATA checks on every program-owned vault). No misdirected-funds path could be constructed.
- **Vault/escrow substitution** — closed by the 2026-10-06 fix commit; canonical-address checks run before any funds move, including the zero-balance fToken vault case in `drain_plan` (`programs/bide/src/instructions/plan.rs:289-298`) and pool vaults in `check_maker_dest` (`programs/bide/src/instructions/settle.rs:155-166`).
- **Oracle** — `load_price_update` pins account owner to the configured Pyth receiver and requires full verification; `read_spot` pins the feed address to `asset.spot_feed`, checks `feed_id`, staleness, and confidence. No attacker-controlled price feed path.
- **CPI** — Lend program, liquidity program, fToken mints, and lending accounts are pinned to constants (`programs/bide/src/lend.rs:50-62`); the residual unvalidated Lend market sub-accounts remain tracked as P-M6.
- **Arithmetic / invariants** — all value math is checked and u128-backed; deposits round up, payouts round down; round replay killed by `round_index == plan.round_count`; single-shot status transitions; escrow fully swept and closed on every exit path.
- **Worker/HTTP** — shared-secret (fail-closed, constant-time compare) on all data endpoints; strict zod schemas with unknown-key rejection; no SQL string interpolation (supabase-js parameterized only); no user-controlled outbound URL host/protocol (no SSRF); secrets never logged or returned (`envReport` emits SET/EMPTY only); server binds 127.0.0.1 by default.
- **App** — no `dangerouslySetInnerHTML`/`innerHTML` anywhere; no hardcoded secrets (the 64-hex strings found are public Pyth feed IDs); wallet flows go through wallet-signed transactions only.
- **Supabase** — RLS enabled on every table; anon gets SELECT-only on public market/showcase tables; `intake_runs` and `telegram_links` have RLS with no anon policy; waitlist is INSERT-only with other privileges revoked; the service key is used only server-side in the worker; no secrets in SQL.

## Known-and-accepted items (unchanged, already in z_review.md — not new findings)

P-H1 front-runnable `init_config` on mainnet, P-H2 single-key upgrade/pool authority, P-H3 admin-controlled oracle/fee params without timelock, P-M1 Lend raw-offset layout read, P-M2 premium forfeit on oracle-failed unwind, P-M3 shortfall underpayment clearing the pool receivable, P-M4 LP exit gated on free funds, P-M5 keeper discretion, P-M6 unvalidated Lend market sub-accounts, W-H3 `reset-and-init.sql` partial-migration footgun, plus the worker/app demo-killers and rate-limit-spoofing LOWs.

## Borderline observations (below the reporting bar, recorded for completeness)

1. `GET /health` on the worker is unauthenticated and returns loop/RPC/agent-queue stats and env SET/EMPTY indicators. Informational only — nothing sensitive is derivable.
2. `app/app/api/desk/runs/[id]` performs no auth of its own and forwards the worker secret, but the underlying `desk_runs` data is world-readable by design (anon SELECT policy / public track-record page), so this adds no exposure under the project's data model.
3. `supabase/reset-and-init.sql` still sits in the repo (W-H3 footgun); per its own header it was never executed.

## Caveat

This is a second review pass, not an audit. "No findings" here means no concrete, high-confidence, exploitable-now vulnerability was found within this pass's scope — it is not a certification of the program. The launch-gate items in `z_review.md` (front-runnable init, single-key authority, timelock-less admin params) remain the real risks to address before mainnet.
