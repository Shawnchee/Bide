# F lane (frontend) notes — terse; orchestrator merges into BUILD/SPEC

## Status (2026-10-05 ~16:00 UTC)
- `app/` = Next.js 16.3.8 (App Router, React 19, Tailwind v4, shadcn radix-nova), package `@bide/app`.
- `pnpm --filter @bide/app build` ✅ (webpack), `lint` ✅, `tsc` ✅. Dev: `pnpm app` (port 3000).
- Routes: `/` `/earn` `/plan/[id]` `/plans` `/desk` `/maker` `/pool` `/auctions`, `/actions.json`,
  `/api/actions/plan` (Blink GET/POST), `/api/actions/icon`, `/api/health`, `/api/quotes/[asset]`,
  `/api/desk/preview`, `/api/desk/runs/[id]`, `/api/waitlist`.
- Wired to `@bide/shared` `BideClient` (create_plan, pause_plan, close_plan, take_round, account decode).
  All signing is gated on the program account being **executable on devnet** (it was not deployed at 16:00 UTC);
  until then buttons are disabled with an honest message. No mock data anywhere.
- Live spot on `/` and `/earn` comes from the devnet Pyth push feed `7AviUf9…` decoded client-side (no key).

## Decisions
- **Webpack, not Turbopack** (`next dev/build --webpack`): `@bide/shared` uses NodeNext `./x.js` specifiers for
  `.ts` files; Turbopack can't alias `.js → .ts`, webpack does via `resolve.extensionAlias` (next.config.ts).
- Browser `Buffer` polyfill (`app/lib/polyfills.ts`) — shared/Anchor use the global.
- `pnpm-workspace.yaml`: added `allowBuilds: unrs-resolver: false` (eslint dep) — without it `pnpm install` exits 1
  for everyone (ERR_PNPM_IGNORED_BUILDS), which would also break Vercel installs.
- Brand: "Evergreen Ledger" (light-first, evergreen accent, Instrument Serif + Geist) — `app/brand.md`.
- Wallets: Phantom + Solflare adapters only (not `wallet-adapter-wallets`, which drags in ~500 deps).
- create_plan tx: `app/lib/tx.ts::buildCreatePlanTx` = [Sell: wrap SOL→WSOL] + `BideClient.createPlan` ixs
  (which already include the 400k CU ix — tx.ts never adds a second one) → v0 message, Lend ALT from
  `NEXT_PUBLIC_LEND_ALT` when set. Plan nonce = `unix*1000 + rand(1000)`; redirect to `/plan/<planPda>?sig=`.
- take_round on `/maker`: put rounds on SOL wrap exactly `size` lamports into the maker's WSOL ATA in the same tx.
- Form → create_plan mapping: lock_strike=true, band=exit_band=0; Buy: target snapped DOWN to $1 tick,
  size = floor(USDC×1e9/strike); Sell: strike snapped UP, target_strike = exit_strike = sell price;
  Both = wheel (target = buy, exit = sell). max_expiry_secs = min(horizon, 35 d) (quick: 1200),
  max_rounds_per_day 6 (quick 30). Min pay presets 5/10/20 bps/day shown as "$0.50/$1/$2 per day per $1,000".
- Fee: every user-facing premium = gross × (1 − fee_bps/1e4); fee_bps from the desk's `get_plan` trace, else 1000.

## Update 2026-10-05 (orchestrator follow-up)
- **Strike tick $0.10** (100_000): never hardcoded. Order = on-chain `Asset.strike_tick` (`useStrikeTick`, also used by
  the Blink POST) → `@bide/shared` `SOL_STRIKE_TICK`/`STRIKE_TICKS.SOL` if P exports one → 100_000n. Buy snaps down,
  Sell/exit up; slider steps are whole ticks; typed price snaps on blur; prices format as "$112" / "$119.40".
- 375 px check (prod build, iframe measurement): no horizontal scroll on / /earn (+review) /plan /maker /desk /pool
  /auctions /plans. /plan and /maker were checked in their pre-deploy empty states only.
- Waitlist migration written: `supabase/migrations/20261005160000_waitlist.sql` (anon INSERT only, no SELECT).

## Needs from other lanes
- **Supabase:** apply `20261005160000_waitlist.sql`. `/api/waitlist` inserts with the anon key (no `.select()`);
  duplicate email (23505) is treated as success.
- **W (rounds mirror, nice-to-have):** `fair_premium` (CEX fair value at open) for the `/auctions` "Exchange fair
  value" column, and `epoch_pubkey` (plan page currently joins epochs by `expiry` timestamptz).
- **W:** `/desk/preview` contract matches (`Authorization: Bearer`, body fields, `{desk_run_id}` 202). The app polls
  `GET /desk/runs/:id` through `/api/desk/runs/[id]` every 1.2 s for streamed steps.
- **P:** publish the Lend ALT address → set `NEXT_PUBLIC_LEND_ALT`. Pool builders (`poolDeposit/poolWithdraw`)
  in `BideClient` once the handlers are enabled → wire in `app/lib/bide-client.ts` (`poolDepositIxs`).
- **Vercel env:** see `app/.env.example` (names only). Root directory = `app`, install from repo root (pnpm workspace).

## Not done / known gaps (honest)
- Nothing signed end-to-end yet: program not deployed on devnet at time of writing.
- `/pool` deposit/withdraw disabled (handlers return `NotImplemented` per notes/program.md).
- Blink POST returns a tx built by the same `buildCreatePlanTx`; dial.to devnet + v0 rendering not verified.
- Plan P&L replay vs Trigger order (Phase 7 #11), `update_plan` edit form (#8): not built.
- Plan "Lend interest" uses `Lending.token_exchange_price` (refreshes on interaction) → may under-report slightly.
