# AI agents v2 — build notes (agent lane, 2026-10-06)

Built from docs/ai-agents.md **as revised by the orchestrator after Fable's review** (no LLM reflection; makers output a spread %, decided per epoch; P&L ledger; grounded theses; intake 202-and-poll; Risk state untouched).
Tests: `pnpm --filter @bide/worker test` → **165/165**. `tsc --noEmit` clean. `pnpm --filter @bide/app build` green; eslint clean on changed files.

## What exists now
| Piece | Where | Notes |
|---|---|---|
| Serial GLM queue | `worker/src/agents/queue.ts` | All GLM calls (desk Quant + GLM risk fallback, intake, maker stances) run one at a time. Priority: desk 0 → intake 1 → maker 2. Stats on `/health` → `agents.llmQueue`. Clef (Workers AI) is not queued. |
| Maker personas | `agents/maker/personas.ts` | maker-1 **Event desk** (calendar + venue dispersion), maker-2 **Momentum desk** (1h/24h/7d moves + fill probability). |
| Stance | `agents/maker/stance.ts` | GLM output `{stance: bid\|pass, spread_pct 0–20, thesis ≤ 280, confidence 0–1}` (zod `.strict()`: a `bid_usdc_base_units` key is rejected). One repair turn. Code: `bid = fair × (1 − spread/100)`, clamped to `[floor, min(start, fair)]`; pass → no bid; **fair < floor → no bid**. |
| Grounding | `agents/grounding.ts` | Every number in a thesis must appear in the maker's inputs (rounding and ×100 % variants allowed). Money/percent tokens (`$x`, `x%`, `x vol`) must match real values, not digits from dates or key names. Events named in a thesis must be of a kind in the context's events list (from events.json); PCE/GDP/ETF/etc. are never citable. Fail → `fallback`, `grounded: false`, thesis kept for audit. |
| Independence | `stance.ts FORBIDDEN_CONTEXT_KEYS` | Maker context = asset, epoch, spot, moves, a 2-strike reference price grid (1 asset, ~2% / 5% OTM), dispersion, events, own inventory + own P&L. Refused before any model call if it contains memo/proposal/rationale/plan-bound keys. |
| Stance service | `agents/maker/service.ts` | Loop `maker-stances` every 15 s. Due when an active, unpaused plan of that kind exists and: quick epoch E → `[E−600−lead, E−540]`; std → `[08:00−lead, 08:30]` for epochs ≥ 12 h out. One stance per (maker, asset, epoch, kind); cached + stored in `maker_stances`. A round in an epoch without a stance triggers one (for later rounds). Quota guard `MAKER_LLM_MAX_PER_HOUR` → fallback stance row. |
| Taker loop | `worker/src/makers/index.ts` | `decideBotBid`: ready LLM stance → derived bid; pending → wait ≤ 15 s after auction start (or half the auction), then fallback; failed stance / `MAKER_LLM` off → deterministic strategy (unchanged: tilted vol + random 2–14 % spread). Bots are now tried **highest bid first** (before: fixed order). Every bid (incl. passes and fallbacks) → `maker_bids` with `bid_hash`; `took` + `tx_sig` set after `take_round`. |
| P&L | `agents/outcomes.ts makerPnl` + `loops/mirror.ts roundOutcomes` | Mirror hook on Live→Resolved, or a vanished Live round on a Resolved epoch (not exercised). `pnl_usdc = holder value at settlement − premium_paid` (put: (K−S)⁺·size; call: (S−K)⁺·size). Pool rounds and Unwound rounds get no P&L. |
| `recent_outcomes` (desk) | `desk/tools.ts`, `desk-tools.ts`, `agents/outcomes.ts` | Deterministic, per plan + per asset (last 20): n, fill rate, paid ÷ start, median seconds-to-fill (inverted from the linear auction), untaken, pool takes, exercise rate, maker win counts, last 5 rounds, plus guidance (may inform: auction_secs, expiry, size, skip; never: limits, strike, premiums, settlement). Quant prompt step 9 requires citing it. `memo.outcomes_cited` (true/false/null) is computed in code. Risk state never includes it (tested). |
| Intake | `agents/intake.ts`, `http/server.ts` | `POST /intake {text}` → 202 `{intake_id}`; `GET /intake/:id`. Shared secret. Max 600 chars, `INTAKE_MAX_PER_MINUTE` (default 6) → 429. zod checks shape only; `validateIntake` checks every field in code (buy price must be below spot / sell above, 0.4–2.5× spot, unit must match side, caps 100k USDC / 1k SOL, deadline 2–179 days, quick/horizon consistency, SOL only). Bad value → null + question. Stored in `intake_runs` (no anon read). |
| App | `app/api/intake/**`, `components/earn/intake-box.tsx`, `components/agents/*`, `components/desk/track-record.tsx` | /earn "Describe your goal" (polls every 2 s, gives up at 4 min) pre-fills the form + shows assumptions/questions; signing still goes through Review. /auctions: per-maker P&L ledger (losses in red, AI vs fallback counts), independence note, each round's bids (bid / passed, fair, % under, confidence, AI stance vs Fallback badge + reason, Won, thesis). /plan/[id]: "What each maker bid" for the current round. /desk: "What the desk learned" (same stats as `recent_outcomes`, computed client-side from `rounds`) + "Cites track record" badge. Empty states, no mock data. |

## Live smoke (2026-10-06 ~06:00 UTC, real keys, `pnpm --filter @bide/worker exec tsx src/agents/verify-live.ts [maker|intake|desk]`)
- **maker-1 Event desk** (11.0 s): `bid`, spread 3 %, conf 0.8, grounded — "Quiet window: no macro events inside the 3.09-day life and 3 venues agree within 0.71 IV vol pts, so I bid near fair on puts…". Example round: fair $1.1127 → bid $1.0793.
- **maker-2 Momentum desk** (13.3 s): `bid`, spread 7 %, conf 0.65, grounded — "SOL is down -0.33% in 1h and -0.51% in 24h, so near-term momentum favours put protection…". Example → bid $1.0348. The two makers disagree, as intended.
- **intake** (27.9 s): "buy around $300 of SOL if it dips about 8 bucks below today's price, next few weeks, not in a hurry" → goal buy, SOL, amount 300 USDC, horizon 1m, min_pay standard, patience patient; target left **empty** with the question "should I set your buy price at about $111.81?"; assumptions listed (1 month, standard pay).
- **desk preview** (61 s, 5 GLM calls): Quant called `recent_outcomes`, chose `skip` (floor below the user minimum), rationale "recent_outcomes shows 0 past rounds…". This exposed a gap in the citation regex ("0 past rounds"), now fixed and tested.

## Decisions / deviations (also in SPEC decision log)
- **Stance lead 240 s, not 90 s.** With one serial queue, maker calls placed in the desk's 90 s lead would sit between the Quant's turns (the queue only reorders waiting jobs, it can't pre-empt a running call). 240 s makes stances finish before the desk starts. Configurable.
- **Fair < floor → no LLM bid** (the clamp range would be empty; clamping up to the floor would pay above fair).
- **Premiums are not adapted** from `recent_outcomes`. The Quant copies them from the price-grid cell (the desk rule "LLM never does arithmetic" wins).
- **REQUIRED_TABLES now includes maker_stances, maker_bids, intake_runs.** The migration also adds `rounds.asset / auction_secs / pool_delay_secs`, which `roundRow()` now writes. On a project with only the init migration the worker falls back to the in-memory store (logged) instead of failing every rounds upsert.
- **Intake errors** are shown to the user as a plain message, not model internals. There is no deterministic intake parser (it would be a mock); on failure the user fills the form.
- **`createDeskFromEnv` takes an optional 4th arg `wrap(transport)`.** That is how the desk joins the queue. The A-lane API is otherwise unchanged.

## Known limits / honest caveats
- The maker reference grid is for 1 asset at ~2 %/5 % OTM. The stance is relative to fair, so the round's own strike and size are applied at bid time.
- Theses can still cite digits from dates (e.g. "14" from a CPI date) for non-money numbers; money and percent figures must be real values.
- A worker restart loses the mirror's previous snapshot. A round that resolves during the restart gets no P&L row; the next resolve is unaffected.
- Quota: in the worst case (an active quick plan all day) maker stances need 2 calls per 10 min = 12/h, under the 30/h guard. The desk's own quick runs already use far more.
- Rationale leak (pre-existing, notes/desk.md): in the live desk preview the Quant wrote plan bounds into its rationale. Risk only sees the rationale when the action is open.

## Deploy checklist (orchestrator)
1. Apply **both** migrations in order on the new Supabase project: `20261005150000_init.sql`, `20261006090000_agents.sql` (+ waitlist). Do this **before** starting the new worker, or it falls back to memory.
2. Worker env (all optional): `MAKER_LLM` (default on when `ZAI_API_KEY` is set; `0` = deterministic makers only), `MAKER_STANCE_LEAD_SECS` (240), `MAKER_LLM_MAX_PER_HOUR` (30), `MAKER_LLM_TIMEOUT_MS` (300000), `INTAKE_ENABLED` (1), `INTAKE_MAX_PER_MINUTE` (6), `INTAKE_TIMEOUT_MS` (120000), `ZAI_MODEL_AGENTS` (defaults to `ZAI_MODEL_MAIN`). Intake also needs `WORKER_SHARED_SECRET` on both the worker and Vercel, plus `WORKER_URL` on Vercel.
3. App env: `NEXT_PUBLIC_MAKER_BOTS=<maker-1 pubkey>,<maker-2 pubkey>` (WALLETS.md). The tape and the desk track record use it to name the makers.
4. Restart the worker and check `/health` → `agents: { makerLlm: true, intake: true, llmQueue }`. Logs: `maker stance` before each window, `bid` lines with `source`, `maker pnl` at resolve.

## Telegram removed (2026-10-06, user decision)
Reason: not needed, and the `/start <plan_pubkey>` linking let any chat subscribe to any plan (authorization bug). The mirror still derives plan events (`PlanEvent` in `loops/mirror.ts`) and logs them; nothing is sent anywhere. The `telegram_links` table stays in `20261005150000_init.sql` but is no longer read or written, and is no longer probed at startup (`REQUIRED_TABLES`).
Files changed:
- deleted `worker/src/notify/telegram.ts` (whole `notify/` dir)
- `worker/src/index.ts` (no Notifier, no `telegram` loop, `/health` status drops `telegram`)
- `worker/src/loops/mirror.ts` (`NotifyEvent` → local `PlanEvent`; `Mirror` constructor no longer takes a notify callback)
- `worker/src/config.ts` (`telegramBotToken` and `TELEGRAM_BOT_TOKEN` env report removed)
- `worker/src/db/types.ts`, `memory.ts`, `supabase.ts` (`TelegramLinkRow`, `upsertTelegramLink`, `telegramChatsFor` removed), `worker/src/db/index.ts` (`telegram_links` dropped from `REQUIRED_TABLES`)
- `worker/test/integration.test.ts` (Telegram parse/format test removed) → worker tests 164/164
- `app/components/plan/plan-view.tsx` ("Get notified on Telegram" button + `NEXT_PUBLIC_TELEGRAM_BOT` removed)
- `.env.example` (`TELEGRAM_BOT_TOKEN`), `app/.env.example` (`NEXT_PUBLIC_TELEGRAM_BOT`)
- docs: `worker/DEPLOY.md`, `README.md`, `BUILD.md` §4.5/§7, `SPEC.md` (feature 11 + decision log), `HANDOFF.md`, `WALLETS.md`
Deploy note: the VM's worker `.env` may still hold `TELEGRAM_BOT_TOKEN`; it is now ignored. Redeploy the worker to stop the old bot polling.
