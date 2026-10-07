# Std window runbook — 7 Oct 2026, 08:00–08:30 UTC (16:00–16:30 SGT)

Written by integration run #3 (2026-10-06), updated 2026-10-06 11:30 UTC. The keeper runs on the **ECS VM** (pm2, user `bide`, Supabase store); the laptop worker is stopped. All commands run from `scripts/` unless noted. Keypairs are loaded by path (`keys/*.json`); never print them, and redact any RPC URL containing `api-key=`.

## Facts that drive the timing
| Rule (program) | Value |
|---|---|
| Std `open_round` allowed | `(now − 08:00 UTC) mod 86400 < 1800` → 08:00:00–08:29:59 UTC |
| Std expiry | 08:00 UTC; must be **≥ 12 h after the open** → rounds opened on 7 Oct target **8 Oct 08:00 (1791446400)** or **Fri 9 Oct 08:00 (1791532800)**, never 7 Oct |
| Auction | default **300 s** (decision 2026-10-06), then 60 s pool delay. `take_round` only until pool_open = `auction_start + 360 s` (`AuctionOver` after); then only `pool_take_round` in `[pool_open, pool_open + 60]`; the keeper cancels after that |
| Spot feed | `open_round` / `take_round` / `pool_take_round` need the push feed ≤ `max_spot_age_secs` = **300 s** (devnet; raised from 180 on 6 Oct) |
| Sampling window | `expiry − 1800 … expiry` (10 buckets × 180 s); for an 08:00 expiry: **07:30–08:00 UTC** |
| Grace | `expiry + 3600` — samples can still be posted (historical Hermes updates) until **09:00 UTC**; after that an epoch with ≥ 8 samples resolves, otherwise it fails and rounds unwind |

Epochs on-chain (checked 2026-10-06 04:44 UTC, all Open): 7 Oct `DSNEqx3Pm7dn7HpTAgvbwcEC9LC3nTe9t7rWR14CcGRk`, 9 Oct `8LcB4fPVURvgJdxTLLdu2VbHeZUcvyyi17ujkqf3zFPc`, 16/23/30 Oct. 8 Oct is opened by the keeper after 6 Oct 08:00 (it keeps the next two dailies open); `open-round-manual.ts` also opens it if it is missing.

**Only rounds opened in the 6 Oct 08:00–08:30 window can settle at 7 Oct 08:00.** Outcome of that window:
- **Live:** call round `5CcfmgSseQNn8jQUWCDpBx1pJLrtzzj5ZLUCNbRydpcc` (std sell plan `8kaDR2Snm1fBPXjjSAobfLvZ3pF89T9r3oNmJ6fqgdze`, K $121.10), opened 08:03:10, taken by maker-2 08:08:14. **It is the only round on the 7 Oct epoch.** Samples 07:30–08:00, resolve after 08:00.
- **Cancelled:** put round `4vsDuo…` (std buy plan `GZyrcLHj…`): makers held on a 227 s-old feed (limit was 180), no pool then → cancel at pool_open. Since then: spot age 300 s, pool `3vY4n9Wm…` funded (25 USDC + 0.5 WSOL), keeper holds the pool take while the feed is stale.

## Timeline (7 Oct, UTC)
| Time | Action |
|---|---|
| 07:00 | Pre-flight (below). Fix anything red now. **No worker restart 07:20–08:40.** |
| 07:30–08:00 | Round `5Ccfmg…` is Live on the 7 Oct epoch: the sampler posts bucket i at 07:30 + 180·i + 2 s. Watch the log. |
| 08:00:05–08:01 | Keeper: `resolve_epoch` (7 Oct), then `resolve_round` + `withdraw_collateral` for exercised rounds. |
| 08:00–08:05 | Open std rounds. **Default: the desk.** Z.ai/Clef keys are set as of 6 Oct 05:13, and a desk-opened quick round was proven at 06:00 that day. The keeper runs the desk for each active std plan from 08:00:00 and logs a `desk run` line (memo_hash, Clef answers, memo JSON). Std desk runs take ~50–100 s. Use the manual commands below only for a plan with no `open_round` / `desk run` by 08:15, or when the desk errors. **Not both** (the script refuses a plan that already has an active round). |
| 08:05–08:11 | Auctions run 300 s + 60 s pool delay. Makers take before pool_open; untaken rounds → keeper `pool_take_round` in `[pool_open, pool_open + 57 s]` if the caps allow (premium ≤ 150 bps of notional, open notional ≤ 40 USDC, ≤ 2 USDC spent per 24 h), else `cancel_round`. |
| by 08:25 | Last safe time to open a missed plan (leave margin before 08:29:59). |

## 1. Pre-flight (07:00)
```bash
# on the VM, as user bide
pm2 ls                                            # bide-worker online; exactly ONE worker anywhere (laptop stopped)
curl -s localhost:8787/health | jq '.ok, [.loops[] | {name, consecutiveErrors, lastOkAt}]'   # on the VM (no public route)
./node_modules/.bin/tsx integration/state.ts       # SOL/USDC/WSOL of demo-user, deployer, keeper, makers
./node_modules/.bin/tsx integration/plans.ts       # active std plans + std epochs (7, 8?, 9 Oct)
```
Check:
- `/health` is 200 and `ok: true`; keeper, sampler, makers have `consecutiveErrors: 0` and a recent `lastOkAt`.
- Keeper ≥ 1 SOL (each Pyth sample = 2 txs with rent that is mostly reclaimed). Makers: enough USDC for calls (K × Q) and WSOL for puts (Q), plus ~0.05 SOL.
- The worker runs on the ECS VM. Only if it falls back to a laptop: AC power, lid open, `caffeinate -dimsu &` (clamshell sleep on battery froze the worker on 6 Oct, notes/integration.md).
- The worker must run code that has `DEFAULT_AUCTION_SECS.Std = 300` (worker/src/keeper/schedule.ts) and the 6 Oct data-flow fixes (notes/data-flow-fixes.md; deployed 10:02 UTC).

Push feed: `open_round` and `take_round` read spot from `asset.spot_feed` and fail with `StalePrice` if it is older than `max_spot_age_secs` (devnet **300 s** since 6 Oct 09:56). The sponsored devnet feed usually updates every ~60 s but gapped 320 s (04:45) and 227 s (08:06) on 6 Oct. The script, the makers and the keeper's pool take now hold for a fresh update instead of failing. Watch the feed with:
```bash
./node_modules/.bin/tsx integration/feed-age.ts --mins 40     # prints each new publish_time and the gap
```

Dress rehearsal (any time, sends nothing): build and simulate the real `open_round`. Outside the window the expected error is `OutsideAuctionWindow (6001)`, which means every earlier check passed.
```bash
./node_modules/.bin/tsx open-round-manual.ts --plan <STD_PLAN> --expiry 1791532800 --simulate
```

## 2. Open std rounds (08:00, manual fallback when there is no desk)
For each Active std plan from `integration/plans.ts`:
```bash
./node_modules/.bin/tsx open-round-manual.ts --plan <STD_PLAN> --expiry 1791446400 \
  --source manual-fallback --note "Std window 7 Oct: desk unavailable; worker pricer output as-is."
# or --expiry 1791532800 (Fri 9 Oct) when the target is 3–8% from spot (SPEC band: ~1 week)
```
- Defaults: strike = plan target (put) / exit strike (call), size = all remaining (`--size-frac 0.33` for a ladder), `--auction-secs 300`.
- Exit 3 = the pricer floor is below the user's minimum or 0. **Do not `--force`.** Skip the plan: an honest skip, not a rejection. Try the other expiry once.
- Exit 2 = the pricer has fewer than 2 venues (common for 1-day expiries). Try 9 Oct.
- Exit 5 = the Pyth push feed stayed staler than `max_spot_age_secs − 20 s` until the window closed (the script waits for a fresh update first; nothing was sent).
- Exit 4 = the program rejected it; the tx link is printed. Record it in notes/integration.md.
- The memo is written to `notes/memos/<round>.json`; its sha256 is the on-chain `memo_hash`.
- Run the plans back to back. Each takes ~2–5 s (the pricer is cached after the first).

## 3. What to check after opening
```bash
./node_modules/.bin/tsx integration/inspect.ts --plan <STD_PLAN>            # round status Auction → Live, maker, premiumPaid, feePaid
./node_modules/.bin/tsx integration/sigs.ts <STD_PLAN>                      # OpenRound, TakeRound, …
tail -f <worker log> | grep -E '"mod":"(makers|keeper)"'                    # take_round / pool_take_round / cancel_round
```
- Expected: a maker takes within 300 s (bots bid near fair; P(fill) in the dress check was 0.2–0.3 at the floor, but the bots take once the falling price crosses their bid).
- Untaken by pool_open (360 s) → keeper `pool_take_round` (caps permitting) or `cancel_round`. Collateral stays in Lend either way. The plan can be reopened in the same window (rate limit `max_rounds_per_day`).

## 4. Fallback: keeper/worker down
1. **Start one worker** (only if none runs anywhere: check the VM *and* the laptop):
   - VM (as user `bide`): `pm2 restart bide-worker && pm2 logs bide-worker --lines 50`.
   - Laptop (from `worker/`): set `PROGRAM_ID`, `HELIUS_RPC_URL`, `KEEPER_KEYPAIR=keys/keeper.json`, `MAKER1_KEYPAIR=keys/maker-1.json`, `MAKER2_KEYPAIR=keys/maker-2.json` (paths, not contents), then `./node_modules/.bin/tsx src/index.ts`. Pipe its output through `sed -E 's/api-key=[^&" ]*/api-key=REDACTED/g'` into the log. Keep the host awake.
2. **Missed samples are recoverable until expiry + 1 h (09:00 UTC on 7 Oct).** The sampler posts every unfilled bucket whose start has passed, using the Hermes update at that exact timestamp. Restarting the worker before 09:00 settles the epoch normally. With ≥ 8 of 10 samples it resolves after 09:00; with fewer it fails, and the keeper (or anyone) unwinds the rounds: each side gets its escrow back, the user keeps the premium.
3. **Opening rounds needs no worker:** `open-round-manual.ts` signs with `keys/keeper.json` (= `Config.agent`). But takes need the maker bots (in the worker) or a manual take on `/maker`.
4. If the 08:00–08:30 window is missed entirely, nothing is lost. Plans keep earning in Lend; the next window is 8 Oct 08:00 UTC.

## 5. After the window
- Append to `notes/integration.md`: per plan, the open/take (or cancel) sig, premium, maker, and the memo path. Keep the STATUS line current.
- Each round settles at its expiry (8 or 9 Oct 08:00 UTC). The worker must be up from expiry − 30 min until resolve (and no later than expiry + 1 h).
