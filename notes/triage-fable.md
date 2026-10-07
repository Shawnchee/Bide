# Triage — Fable 5.1 senior review (2026-10-06, read-only)

## Verdict
**Demo-ready for a babysat live demo; not judge-unassisted-ready.** The chain path is proven (both exercise paths, unwind, expire, desk-opened round). The soft spots are off-chain: one serial GLM queue, a desk with no deterministic fallback, one-shot `open_round` submission, and copy that overstates a few things. Fix first:
1. **Eligibility/ops (P0).** README has no "try it yourself" path or pre-existing-work line (HACKATHON.md checklist unticked). Confirm VM `/health` says `repo: "supabase"` (at 05:13 today the worker silently fell back to memory → every page empty) and Vercel has `NEXT_PUBLIC_MAKER_BOTS`, `NEXT_PUBLIC_LEND_ALT`, `QUICK_PLANS_ENABLED` matching the worker. (The Supabase MCP in this session points at another project, so I could not check tables.)
2. **One-shot opens (P0).** `worker/src/keeper/index.ts:150` — a transient `open_round` failure (blockhash expiry, RPC timeout) returns `submit_failed` while `deskDone` already holds the window key (`:130`) → the plan loses the whole window (24 h for std). Retry `submitOpenRound` with the same memo while `waitForWindow` is still open (≤3×).
3. **Queue vs quick window (P1).** `/earn` previews enqueue at `PRIORITY.desk` (0), same as keeper runs, FIFO (`agents/queue.ts:39`). Quick lead is 90 s (`keeper/plan.ts:117`) against measured 52–99 s runs; one judge preview or a second quick plan ahead → `WindowMissed` every epoch. Add a keeper priority above previews; raise `QUICK_DESK_LEAD_SECS` to ~180 (and the `E−690` filter in `desk/tools.ts`).

## 1. Unattended worker (~34 h)
- **P0 Desk is a hard dependency.** `startDesk` returns if `desk` is null; error/veto/skip → no tx, no code-side opener. Z.ai outage or quota = zero rounds. Add a deterministic fallback (pricer floor/start, memo `source: fallback`) when the desk throws.
- **P0 Skip-storm quota burn.** A quick plan the desk keeps skipping (floor < user min) costs ~5 GLM calls per 10 min for up to 3 h, plus 2 maker calls/epoch; three such judge plans ≈ 100+ calls/h on one shared key → desk, intake, previews all degrade. Pre-check `pricer.quote` floor vs user min in the keeper and record a code `skip`.
- **P1 Many plans per quick epoch.** `startDesk` fires for every idle plan at once; serial queue → 2nd/3rd plan always miss the 60 s window. Round-robin one quick plan per epoch, or queue concurrency 2.
- **P1 RPC fallback is single-shot.** `chain/rpc.ts:46–72`: one try on public devnet, which 429s the 4× `getProgramAccounts` snapshot → all loops error together; `/health` goes 503 but nobody is paged (DEPLOY §5 monitor not set). Add an uptime monitor tonight. pm2 `max_restarts: 50` turns a crash loop into a permanent stop.
- **P1 Restart during sampling.** `chain-init` retries at 60 s (`index.ts:124`); std buckets survive, quick (grace 120 s) may not. Never `pm2 restart` inside a quick window with a Live round.
- **P2 Supabase writes.** `appendDeskStep` read-modify-write per step (`db/supabase.ts:36`); a 5xx aborts the mirror tick and possibly the desk run. Wrap `onStep` in `.catch`.
- **P2 Maker inventory.** No USDC top-up; a judge's $200 put needs ~1.7 WSOL from a maker → untaken. Document a judge size cap (≤ $20).
- **P2 Clock.** Sampler uses wall clock, keeper uses block time. Check `timedatectl` on the VM.
- 08:00 boundary is sound; std stances at 07:56 ≈ 24 calls, under the 30/h guard only with no quick plan active.

## 2. Live-demo failure modes (/earn)
- **P1 Preview timeout.** `use-desk-preview.ts:86` gives up at 120 s; runs take 50–100 s alone and queue behind keeper runs. Raise to 240 s; say "you can start without the quote" (button isn't gated).
- **P1 Balance messaging.** `review.tsx:107` checks USDC only for buy plans (no SOL for fees/rent) and `lock + 0.01 SOL` for sell (plan PDA + ATAs + Lend position rent likely exceed it). Wallet simulation errors then hit the generic line (`tx.ts:119`). Require SOL ≥ 0.03 on both sides.
- **P1 ALT.** Empty `LEND_ALT` → v0 tx without lookup table; create_plan with 13 Lend accounts may exceed 1232 B → opaque failure. Verify the env; do one browser-wallet create (notes show script creates only).
- **P2 Two "premium" numbers.** Tape shows gross `premium_paid`; plan page shows net (`plan-view.tsx:46`). Tape "Exchange fair value" is always "—" (`cex_fair_premium` never written).
- **P2 Quick first round** may be 10–20 min out (epochs pre-open after the plan is seen; consecutive rounds every 20 min per notes). Empty-state copy says 10. Intake can take 2–3 min inside a window (priority 1).

## 3. Honesty traps
- `/desk` "Real on-chain rejections" counts every `error_code` (`desk-feed.tsx:21,41`) including off-chain `WindowMissed`/`EpochNotFound`/`Transient` (`keeper/index.ts:152`); two WindowMissed runs today already inflate it. Count `status === "rejected"` only.
- "Risk never sees the user's limits" — notes/agents.md records the Quant leaking bounds into its rationale, which Risk reads. Say "given no bounds directly".
- "A public backstop pool buys at the floor" — the one untaken round in the notes was cancelled; confirm `/pool` is funded or soften.
- "Your SOL comes back automatically" — as WSOL in an ATA, and only while the keeper runs.
- Quick toggle "watch a whole cycle in one sitting" — only for near-the-money strikes.

## 4. Adversarial devnet tests (priority order)
1. **Fresh judge wallet, browser only:** new Phantom, 1 SOL + 20 Circle USDC, `/earn` quick buy $20 balanced. Expect v0 create OK, `/plan` within 15 s, desk run ≤ 20 min, maker take, 10 samples, settle banner, "Earned so far" = `premium_paid − fee_paid`.
2. **Sell plan, minimal SOL, no ATAs:** exactly lock + 0.02 SOL, no WSOL/USDC ATA. Expect wrap + create or a clear pre-sign message; after take, owner USDC ATA exists and premium shows.
3. **Queue contention:** at `E−100 s` with one active quick plan, fire 2 previews + 1 intake. Expect keeper still opens (today: likely `WindowMissed`).
4. **Restart mid-run:** `pm2 restart` at `E−560 s` with a Live round elsewhere. Expect no duplicate round, no fake "Rejected on-chain" row, remaining buckets posted.
5. **Untaken round:** quick plan at the far slider edge so both makers pass. Expect `pool_take_round` or `cancel_round`, "No taker" on `/plan`, "Passed" bid rows, `/desk` count unchanged.
