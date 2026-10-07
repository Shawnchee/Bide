# SPEC — Bide: name your price, get paid until it fills (Solana)

> Living doc. Check every decision against `HACKATHON.md` (judging weights).
> **Build execution plan (accounts, instructions, phases, timeline): `BUILD.md`.**
> Status (2026-10-06): **built and running on devnet** — program `4bwT…` (28 ixs), worker on the ECS VM, app not on Vercel yet. What is proven and what isn't: `README.md` §5 and §9. ~~planning only — no code until the hackathon start (4 oct 2026)~~
> Product: physically settled **cash-secured puts + covered calls**, presented as "buy at / sell at" plans. **Everything runs on Solana devnet** (devnet USDC/SOL, devnet Jupiter Lend, Pyth); mainnet is only discussed in §20 as a future path.
> Last updated: 2026-10-06

---

## 1. One-liner

**Name the price you want. Get paid until you get it.**
Jupiter pays you ~4% to wait (Lend APY, live: 4.16% on 2026-10-05). Leaps pays you premium if you think in options. We pay you both, and you only have to say the price you want.

## 2. Problem statement

- **Limit orders are dead capital.** A pending Jupiter Trigger limit order earns $0. The user gives the market a free option (the right to fill at their price) and gets nothing for it.
- **Jupiter's fix is partial.** *Earn on Recurring* — in Jupiter's docs **Trigger v2 DCA "Earn While You Wait"** (`jlEnabled`) — routes idle USDC/USDT/JupUSD in **time-based DCA** orders into Jupiter Lend (APY = Lend rate, ~4.16% on 2026-10-05; always fetch live). **Price (limit) orders earn nothing**, are held in Privy-custodial vaults, have a $10 minimum, and fill at market price when triggered (output not guaranteed). *(Check the current marketing name before putting it on a slide.)* It only covers DCA, and only pays lending yield.
- **Options yield exists but needs options knowledge.** **Leaps Finance** (verified 2026-10-05): live on Solana **mainnet** (beta, position caps), **Sec3-audited**, backed by Wintermute Ventures/Delphi; covered calls + cash-secured puts on SOL/BTC, physical settlement (Pyth + Chainlink), user picks strike (slider) and expiry (7–28 d menu), **RFQ auction with pro makers** (Wintermute, Galaxy, GSR, Cumberland named). **No** lending yield on collateral, **no** AI, **no** auto-roll / multi-round goals, **no** changes or exit before expiry, no shareable links. Fees and TVL undisclosed. **Honest read:** Leaps already ships the core instrument with real makers — we can't win on "a better option"; we win on what wraps it: price + deadline goals run automatically, Lend yield on the collateral, a verifiable AI desk the program can overrule, plan edits between rounds, open maker/LP access, Blink.
- **Real goals span weeks, not one expiry.** "Get 50 SOL under $110 this quarter" or "sell my BTC once it hits my target." Nothing on Solana runs that whole plan for a beginner.

**Demand evidence:** Binance Dual Investment (same product, CEX) has 500K users. Rysk ("buy low / sell high" on Hyperliquid) has $43M TVL and $1.2B cumulative notional. Jupiter's own "Get paid to wait" campaign confirms the demand.

## 3. Who it's for

**Primary:** a Solana holder or USDC saver who already uses limit orders or DCA on Jupiter and "just wants to earn." They don't know what a put is and shouldn't need to.
**Secondary:** market makers who want a steady supply of SOL/BTC options at fair prices (there's little options supply on Solana).

## 4. Solution: what we build (depth over breadth)

### Core concept: Target Plans
The user states a goal. The system runs it as a series of option cycles until the goal is met.

| User says | Under the hood |
|---|---|
| "Buy SOL at $110" (accumulate) | Cash-secured puts at or near $110, collateral in USDC → jlUSDC |
| "Sell my SOL at $150" (exit) | Covered calls at or near $150 |
| "Buy at $110, then take profit at $150" (full wheel) | Puts until filled, then calls until filled |

Every cycle: premium is paid upfront to the user's wallet, collateral earns Jupiter Lend yield, and the agent desk decides the next cycle.

### Features (and nothing else for v1)
1. **Beginner Earn flow:** pick an asset, pick a target (or a preset), pick an amount, sign once.
2. **Agent desk (2 AI roles):** Quant (GLM 5.3) proposes each cycle's expiry, size, premium bounds and whether to skip; Risk (Cloudflare Clef) approves / adjusts / vetoes; the program enforces the user's bounds. Between rounds: roll / skip / flip / stop.
3. **On-chain program:** escrow, Jupiter Lend collateral, Dutch auction for premium, Pyth sampled settlement, physical delivery (escrow swap), agent guardrails, permissionless unwind if the keeper dies.
4. **Maker agents + backstop pool:** two AI maker agents (GLM stance per epoch, code-computed bid, deterministic fallback) compete in the auction; an LP pool buys at the floor if no maker does (initialised 2026-10-06; no pool take yet).
5. **Shareable Blink:** a Solana Action link ("Buy SOL at $110 — get paid while you wait") that opens a prefilled plan and signs `create_plan` from an X post or any Blink-aware wallet.
6. **"vs Jupiter / Leaps" panel:** per-plan dollars — this plan vs a Jupiter Trigger order vs Earn on Recurring vs a single Leaps option (no yield, manual re-open).
7. **Change plan between rounds** (`update_plan`): move target, deadline or minimum yield; user-signed. *(Program + tests done; `/plan` edit form not built.)*
8. **Payoff slider** on the confirm screen: "if SOL ends at $X on <date>, you get …" (code, not LLM).
9. **Public auction tape** (`/auctions`): every round's start, floor, CEX reference, winning bid and winner.
10. **Plan P&L vs a plain limit order** on `/plan/[id]`, replayed from Pyth history. *(Not built.)*
11. ~~**Notifications** (Telegram bot) on fill, round close and deadline.~~ Removed 2026-10-06 (decision log).

## 5. Beginner UX

**Rule: no Greeks, no "put"/"call" in the main flow.** Options words live only in a "How it works" drawer.

**Earn screen (one page):**
1. *"What do you want to do?"* → **Buy cheaper** / **Sell higher** / **Both**
2. *Asset* → SOL · BTC
3. *Target* → a slider with 3 presets: **Patient** (far from spot, lower pay, less likely to fill) · **Balanced** · **Eager** (near spot, higher pay, more likely to fill). Or type a price.
4. *Amount* → e.g. 500 USDC
5. *By when?* → **1 week · 1 month (default) · 3 months**, or pick a date (max 6 months). Reads back as one sentence: **"Buy 4.5 SOL at $110 or lower, trying until Nov 5."** If it hasn't filled by then, the USDC comes back automatically with everything earned.
6. **Plain-English card** (written by the agent desk, numbers from code; figures below are illustrative, SOL ≈ $121 on 2026-10-05):
   > You get **$6.20 now**.
   > On **Oct 21**, if SOL is **below $110**, you buy **4.55 SOL at $110**.
   > If not, you get your **500 USDC back**, keep the $6.20, and earn ~**$0.90** Jupiter Lend interest.
   > Then we set up the next round automatically (you can stop anytime between rounds).
   > ⚠️ **Checked once, on Oct 21 at 08:00 UTC — not the moment price touches $110.** If SOL dips to $105 midweek and is back at $115 on Oct 21, you don't buy (you keep the $X). If SOL crashes to $80, you still buy at $110.
   > **Same price as a limit order, different trigger.** (Never say "same as a limit order".)
7. **One button:** "Start earning" → one wallet signature.

**"Why this?" drawer:** the agent desk's short debate and final decision memo, plus "memo hash stored on-chain ✓" with an explorer link.

**Dashboard:** current round, time left, earned so far (premium + Lend yield), progress toward the goal, and the "vs Jupiter" comparison.

## 6. Where option prices come from (no Solana options order book exists)

**We don't pull bid/ask from anywhere. Our auction creates the market.**

| Piece | Source |
|---|---|
| **Strikes** | **The user's target is the strike.** **"Lock my exact price" is ON by default.** If the user turns it off, the agent may only nudge in the **user's favour** (puts: at or below the target; calls: at or above) — a one-sided bound stored in `Plan` and enforced on-chain. Snapped to a tick grid (SOL **$0.10**, BTC $250). |
| **Expiries** | **Epochs** (decision 2026-10-05): every round joins a shared epoch for its asset + expiry — daily 08:00 UTC, weekly and monthly on Friday 08:00 UTC (Deribit convention). All rounds in an epoch auction in the same window, share one set of Pyth samples, and settle together. New plans wait in Jupiter Lend for the next epoch. **Round length depends on how far the target is from today's price** (daily rounds on a far target pay ~0): within 3% → 1–2 days; 3–8% → ~1 week; > 8% → 2–4 weeks; never past the user's deadline. Quant picks inside these bands from `price_grid`. **Quick plan** (opt-in, labelled): 10-minute epochs on the same code path, so anyone can watch a full cycle in one sitting. |
| **Fair value (reference)** | **Real CEX options quotes only — nothing made up.** Venues: **Deribit, OKX, Bybit, Binance** (all list SOL, BTC, ETH options; public APIs, no key). See "Pricing rule" below. |
| **Auction anchors** | Auction **start** = consensus fair premium × 1.3. Auction **floor** = **median venue bid** × 0.9 (decision: median, not the single highest bid). The floor is still close to what a pro maker could sell the same option for on a CEX, so the user is never paid far below the real market. |
| **Actual price (bid)** | Set by **makers in the Dutch auction**. The reference value sets the auction's start and floor; the makers set the real price. |
| **Who sets bid/ask** | **Not the user.** The user only sets the target (strike), size and timing. Makers and the pool are the bidders; the CEX data sets the auction's start and floor. |
| **User protection** | Each Round stores a **minimum premium** equal to the auction floor (computed from CEX data when the round opens, and never below the user's own minimum yield setting). The program rejects any fill below it, so a stale or wrong reference can't fill the user at a bad price. |

### Pricing rule (decided)

Why not a plain average: venues differ in depth and freshness, and one stale or thin quote would drag an average around. So:

1. **Pull** every listed option for the asset from all 4 venues every ~10 s: strike, expiry, bid IV, ask IV, mark IV, timestamp.
   - **Deribit** (primary, deepest): `GET /api/v2/public/get_book_summary_by_currency?currency=USDC&kind=option` → SOL options are `SOL_USDC-<expiry>-<strike>-<C|P>` (704 listed on 2026-10-05; BTC: 946 under `currency=BTC`). Gives `bid_price`, `ask_price`, `mark_price` (USDC), `mark_iv` (**percent**, e.g. 55.64), `underlying_price`. Bid/ask IV is implied from `bid_price` / `ask_price` (Black-76 on `underlying_price`) — ~700 `public/ticker` calls per refresh isn't viable.
   - **OKX:** `GET /api/v5/public/opt-summary?uly=SOL-USD` → `instId` like `SOL-USD_UM-261007-114-C`, `markVol`, `bidVol`, `askVol` (**decimal**, e.g. 0.51; `"0"` = no quote), `fwdPx`. 146 listed.
   - **Bybit:** `GET /v5/market/tickers?category=option&baseCoin=SOL` → `symbol` like `SOL-30OCT26-95-C-USDT`, `markIv`, `bid1Iv`, `ask1Iv` (**decimal**; `"0"` = no quote), `bid1Price`, `ask1Price`, `underlyingPrice`. 336 listed.
   - **Binance:** `GET https://eapi.binance.com/eapi/v1/mark` (filter `SOL-…`) → `symbol` like `SOL-261030-122-C`, `markIV`, `bidIV`, `askIV` (**decimal**). 92 SOL listed.
   - *All four verified live, no API key, on 2026-10-05.* Normalise IV units (Deribit is percent) and treat `0` IV as "no quote".
2. **Filter:** drop quotes older than 30 s, with no bid, or with a bid/ask spread wider than **10** vol points. (Kept for now even though it often leaves 1-day rounds unpriced — the desk then picks a longer expiry. Open choice: 20 vol points for T < 2 d.)
3. **Interpolate per venue** to our exact strike and expiry (strike: linear in log-moneyness; expiry: linear in total variance). Don't extrapolate outside a venue's listed range.
4. **Consensus:** use all venues that pass. Fair IV = **median of venue mid-IVs**. Bid IV = **median of venue bid-IVs** (not the single highest — one stale/thin bid must not set the floor). Interpolate in log(K/F) using each venue's own forward/underlying price, then reprice. On-chain clamp: `floor ≤ fair ≤ start`.
5. **Price** with Black-Scholes using Pyth spot → fair premium and best-bid premium in USDC.
6. **Need at least 2 venues** passing the filters, otherwise don't open the round (stay in Lend, retry). Build order: Deribit + Bybit + OKX first, Binance last (Binance's options API ✅ reachable from the Malaysia VM (2026-10-05)).
7. **Show it:** the "Why this?" drawer lists each venue's quote and the consensus, so users and judges can see the price is real.

**The Quant agent never invents numbers.** It calls `price_grid()` and `fill_probability()` tools written in code.

## 6b. Tech stack

| Layer | Choice |
|---|---|
| On-chain program | Rust + **Anchor v1 (stable)**, deployed to **Solana devnet**. Not Anchor v2 (alpha). |
| Yield | **Jupiter Lend Earn** CPI (devnet USDC + WSOL markets) |
| Oracle | **Pyth** pull oracle (`pyth-solana-receiver-sdk`): bucketed median-of-samples for settlement (§7); Hermes for off-chain prices |
| Options data | **Deribit, OKX, Bybit, Binance** public APIs (no keys) |
| Pricing service | TypeScript / Node: poll venues, IV interpolation, Black-Scholes, consensus |
| Agents | TypeScript. **Quant = Z.ai GLM 5.3** (tool calling) · **Risk = Cloudflare Clef** via Workers AI REST (GLM strict-JSON fallback) · card = deterministic code *(confirm Z.ai endpoint + tool-call format at kickoff)* |
| Keeper + maker bots + pool seeding | TypeScript + Anchor TS client. **JS SDK:** use whatever the Jupiter Lend SDK and Anchor client expect (likely `@solana/web3.js` 1.x) — check at kickoff. **Don't adopt web3.js v3.0.0** (released 1 Oct 2026, still on the `next` tag until 19 Oct, breaking async/bigint changes; ecosystem libs won't be compatible yet). `@solana/kit` only where no 1.x-bound lib is involved. |
| Frontend | **Next.js (App Router) + Tailwind + shadcn/ui**, Solana wallet adapter (Phantom/Solflare), devnet. Why Next over Vite: server-side API routes keep the Z.ai key off the client, and one app holds the landing page + app. Long-running services (pricing poller, keeper, makers) still run on the ECS VM, not Vercel. |
| Storage | **Supabase** (plans, rounds, decision memos, quote snapshots) |
| Hosting | Next.js on **Vercel**; worker = one always-on **Node process on the user's **ECS VM** (8 GB RAM; region **Malaysia** (✅ checked 2026-10-05 from the VM: Deribit, OKX, Bybit, Binance options APIs, Hermes, devnet RPC, Z.ai, Cloudflare API all reachable); `pm2`/systemd auto-restart; Caddy for HTTPS; secrets in a chmod-600 env file)**; demo laptop as hot fallback. Clef is still called over Cloudflare Workers AI REST. |
| Dev tooling (MCP) | **Solana Developer MCP** (`mcp.solana.com`: docs + Anchor docs search, Anchor/Pinocchio program autofixer) and **Solana Explorer MCP** (`explorer.solana.com/mcp`, no key, covers devnet) for debugging our transactions. Dev-time only. |

## 7. Settlement oracle (revised after stress test)

**Pyth's custom TWAP is gone:** deprecated 31 Jan 2026 and removed 6 Feb 2026 ("TWAPs are not available anymore on Hermes endpoints"). It was also capped at 10 min. So no 30-min Pyth TWAP.

**Primary design: bucketed median of Pyth samples.**
- Samples are taken **per epoch** (one set serves every round in it). The settlement window (std: 10 × 180 s = 30 min; quick: 10 × 10 s) is split into **N fixed buckets** (10).
- Each bucket accepts **exactly one** Pyth price update: the first one at or after bucket start — `prev_publish_time < bucket_start ≤ publish_time ≤ bucket_start + tolerance` (Quick 2 s, Std 10 s). Hermes publishes 1 update/s with no gaps, so exactly one update qualifies. Anyone can post (permissionless), but no one can pick among prints. The Pyth receiver does no age check, so this window check is the only defence against replaying old prices.
- Updates come from **mainnet Hermes** (`hermes.pyth.network`); they verify Full on devnet (same guardian set).
- Reject updates whose confidence interval is wider than X bps.
- Settlement price = **median** of the bucket samples (not the mean). Require at least N−2 buckets filled.
- Chainlink stays out (fewer Solana feeds, separate track).

## 8. Settlement mechanics: physical delivery (no swap needed)

**Decision (2026-10-05):** both sides lock what they'd hand over, and at expiry the program just swaps the two escrows. No DEX, no Jupiter Swap, no mock swap. The bucketed median (§7) only decides *whether* the option is exercised.

**Put round (user wants to buy SOL at K), size Q:**
- User locks `K × Q` USDC (held as jlUSDC in Jupiter Lend).
- Maker, on `take_round`, pays the premium to the user **and escrows Q SOL**.
- At expiry, settlement price (bucketed median, §7) = P:
  - `P < K` → **filled.** Escrows swap: user gets Q SOL, maker gets `K × Q` USDC. User bought at exactly K and kept the premium + Lend yield.
  - `P ≥ K` → **not filled.** Maker gets their SOL back; user keeps USDC + premium + Lend yield.

**Call round (user wants to sell SOL at K), size Q:**
- User locks Q SOL (held in Jupiter Lend's WSOL market, so it earns yield too).
- Maker pays the premium and **escrows `K × Q` USDC**.
- `P > K` → filled: user gets `K × Q` USDC, maker gets Q SOL. Otherwise the maker gets their USDC back.

**Who keeps what (both products are physically settled; nothing swaps unless the price crosses the strike):**

| Product | Price at check | Swap? | User (option seller) | Buyer (maker / trader / pool) |
|---|---|---|---|---|
| Cash-secured put ("buy at K") | ≥ K | **No** — each escrow returns to its owner | Keeps premium + USDC + Lend yield | Gets its SOL back; premium is its cost |
| Cash-secured put | < K | **Yes**, at exactly K | Gets Q SOL for K×Q USDC; keeps premium + yield | Gets K×Q USDC for Q SOL |
| Covered call ("sell at K") | ≤ K | **No** | Keeps premium + SOL + Lend yield | Gets its USDC back; premium is its cost |
| Covered call | > K | **Yes**, at exactly K | Gets K×Q USDC for Q SOL; keeps premium + yield | Gets Q SOL for K×Q USDC |

**The user never loses the premium** — it's paid upfront and is theirs in every outcome. Their only "cost" is the obligation to buy/sell at K. The buyer is the one who usually loses the premium.

**Why this beats cash-settle + swap:** the fill is at **exactly** K (no oracle-vs-spot gap, no slippage), makers can't fail to deliver (it's escrowed upfront), and there's nothing mocked. Cost: makers lock more capital, which is fine — pro makers hedge with the underlying anyway, and Thetanuts already runs physically settled options this way.

**Backstop pool:** holds both USDC and SOL so it can escrow either side.

**Settle is permissionless.** Anyone can trigger it after expiry; our keeper normally does.

## 9. On-chain program (Anchor)

**Summary:** accounts `Config`, `Asset`, `Plan` (one per user goal: side, strikes + one-sided bands, size, deadline, user-signed min premium, agent limits, `quick`, `pending_settlement`), `Round` (one per cycle: put/call, strike, size, auction params, maker, premium, memo hash), `Epoch` (shared per asset + kind + expiry: samples + settle price), `Pool` (backstop LP vault), plus PDA-owned token vaults and per-round escrows. Instructions cover plan lifecycle (`create_plan`, `update_plan`, `pause_plan`, `flip_plan`, `close_plan`, permissionless `expire_plan`), rounds (`open_round` by the agent key, `take_round` / `pool_take_round`, `cancel_round`), settlement (`open_epoch`, `post_sample`, `resolve_epoch`, `resolve_round`, retryable `withdraw_collateral`, `unwind_round` on a Failed epoch) and the pool (`pool_deposit`, `pool_withdraw`, `pool_lend_idle`).

**Authoritative: `BUILD.md` §3.2–3.3** (fields, seeds, checks, effects, errors, events). Don't duplicate them here.

### Integrations
- **Jupiter Lend Earn (real, on devnet — verified 2026-10-05):** deposit/withdraw by CPI (~18 accounts each; SDK `getDepositContext()` / `getWithdrawContext()`). Devnet lending program `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3` has live markets, including:
  - **USDC** = Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (free from Circle's faucet) → fToken `2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu`
  - **WSOL** `So11111111111111111111111111111111111111112` → fToken `BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU`
  - (two other 6-decimal test mints, unidentified)
  - *Market accounts decoded from on-chain data by offset; confirm layout with the SDK at kickoff.*
- **Jupiter Swap:** **not used in settlement** (physical delivery, §8). Devnet has no Swap routes, and we're devnet-only. Possible later use: a mainnet "convert" button in the UI via the Router path `GET /swap/v2/build` (needs a Jupiter Portal `x-api-key`).
- **Pyth:** pull-oracle price updates posted per epoch bucket (Full verification); auction spot read from the sponsored push feed. Settlement spans several transactions (samples, resolve, withdraw) — keeps each under the 1232-byte / account limits; use address lookup tables for the Lend CPI accounts.

## 9b. Off-chain services (the "worker")

One TypeScript (Node) process, `bide-worker`, with four modules. One deploy, one log stream; split later if needed.

| Module | Loop | Does |
|---|---|---|
| **Pricer** | every ~10 s | Polls Deribit/OKX/Bybit/Binance + Pyth (Hermes), builds the IV consensus (§6), caches it in memory + Supabase |
| **Makers (×2)** | poll every 2 s (Round accounts in Auction) | On a new Round: compute its own bid (consensus fair × its own spread/vol tilt); when the falling auction price drops to its bid, send `take_round`. Each bot has its own wallet. |
| **Keeper** | every ~5–10 s | Calls `pool_take_round` when an auction hits the floor untaken; posts bucket samples during the window, then calls `resolve_round` + `withdraw_collateral`; asks the agent desk for the next round and sends `open_round` (agent key) |
| **Agent desk** | on demand | Quant (GLM 5.3, tools) → Risk (Clef) → card rendered in code. Called by the keeper between rounds and by `POST /desk/preview` when a user drafts a plan (result precomputed into Supabase; the Next.js route only reads it) |

**Why not plain serverless/cron:** makers must react within a 30–60 s auction and the keeper must run continuously; 1-minute crons are too slow.

**Hosting — own ECS VM (decided 2026-10-05):**
- **Worker:** one always-on Node process on the user's **ECS VM** (8 GB RAM; region **Malaysia** (✅ checked 2026-10-05 from the VM: Deribit, OKX, Bybit, Binance options APIs, Hermes, devnet RPC, Z.ai, Cloudflare API all reachable); `pm2`/systemd auto-restart; Caddy for HTTPS; secrets in a chmod-600 env file) (Hono HTTP + the loops). Same code runs on the demo laptop as a hot fallback; README says so.
- **Server hardening:** SSH key-only, firewall open only 443 (Caddy → worker), keeper + maker keys only in the env file, never in git. Reachability ✅ (2026-10-05): all 4 CEX APIs, Hermes, devnet RPC, Z.ai, Cloudflare API. Still to check: Helius RPC once the key exists.
- **Why not Cloudflare Workers:** `@solana/web3.js` 1.x + Anchor in workerd has Buffer/crypto and 3 MB script-size rough edges, and hosting isn't judged. Clef is still called over Workers AI REST, so the Cloudflare integration is unaffected.
- **As deployed (2026-10-06):** pm2 as user `bide`, worker bound to `127.0.0.1:8787`; **Caddy not used** (80/443 on the VM are taken by another service) → no public worker route yet, so the hosted app's preview/intake/quotes routes can't reach it. External uptime monitor not set up.
- **Uptime:** judges may open the live URL any time after 7 Oct. `/health` pinged by an external uptime monitor; the frontend shows a "worker offline — showing last recorded rounds" banner instead of breaking.
- **Frontend:** Next.js on Vercel.
- Secrets (wallet keys, Z.ai key, RPC URL, CF token): worker → the ECS VM env file (chmod 600); app → Vercel env vars; never in git.

## 10. Dutch auction (makers compete)

- Premium starts at CEX fair value × 1.3 and falls in a straight line to a floor of CEX bid-side value × ~0.9 (see §6) over the auction length (std default 300 s, quick 30 s; program range std 10–1,800 s, quick 5–120 s).
- The first maker to call `take_round` pays the current premium and wins. **Any wallet can be a maker**: the `/maker` page lists live auctions with the falling price and a "Take" button (escrow + premium signed by the maker's wallet).
- **What a Dutch auction is (plain words):** the price starts high and drops every second until someone accepts. The first maker to accept wins. Users never see it; they only see "You got $X ✓" after ~30–60 s.
- **No maker by the floor → backstop pool** buys at the floor premium (`pool_take_round`).
- **Pool full or over its caps → no fill this round:** collateral keeps earning Jupiter Lend yield; the agent desk re-prices and retries at the next window. The user always earns something.
- **Demo makers:** 2 bots (maker-3 wallet kept as an optional extra, config only) with different volatility assumptions; each bot's spread is **re-drawn at random every round** (and each has inventory/capital limits), so the winner varies and the competition is real, not maker-1 every time.

### Backstop pool (LP vault)
- **Who:** **anyone** deposits USDC (and SOL) and gets pool shares (SPL share mint). We're the first LP on devnet; others can join from the `/pool` page.
- **What it does:** buys options only at the auction floor (CEX bid-side value × ~0.9), i.e. below fair value. **No "edge" claim:** implied vol usually exceeds realised vol, and the pool only gets rounds every maker passed on (adverse selection), so a systematic option buyer probably loses on average. Say this plainly on the `/pool` page: v1 is an unhedged backstop LP; v2 hedges (§20).
- **Risk limits (on-chain):** max premium spent per round, max open notional per asset, max % of pool reserved at once. Over a limit → it doesn't bid.
- **Payoff:** the pool pays premium upfront; if the option finishes in the money, settlement pays the pool instead of a maker. LP share value (NAV) = vault balances + Lend USDC + each live pool option marked at intrinsic value (put: max(SOL escrow × spot, strike notional); call: max(USDC escrow, size × spot)) + receivables of exercised rounds (decision 2026-10-07; time value ignored, mark-to-model in v2).
- **How it works:**
  1. `Pool` PDA owns two token vaults: **USDC** (pays premiums, escrows for call rounds) and **SOL** (escrows for put rounds). Fields: `authority`, caps (`max_premium_bps_of_notional`, `max_open_notional`, `max_utilization_bps`, spend-window cap), running `open_notional`, `reserved_usdc/wsol`, `paused` (exact fields: BUILD §3.2).
  2. **Deposit / withdraw:** `pool_deposit` mints shares at NAV; `pool_withdraw` burns shares and pays out only **unreserved** funds. We make the first deposit.
  3. **Fill:** the keeper watches each auction. When it reaches the floor with no maker for N seconds, it calls `pool_take_round`. The program checks the auction really is at the floor and the caps hold, then pays the premium from the USDC vault and escrows the delivery side from the matching vault.
  4. **Settle:** the normal `resolve_round` + `withdraw_collateral`; the pool's vaults are just the counterparty accounts.
  5. Idle pool USDC is parked in Jupiter Lend so LPs earn while waiting.
- **Devnet funding (no real money):** all pool funds are free devnet tokens — SOL from the devnet airdrop/faucet, USDC from Circle's devnet faucet, tBTC minted by us. Faucets are rate-limited, so keep round sizes small (e.g. 10–50 USDC, 0.1–0.5 SOL). Must use **Circle's** devnet USDC (not our own mint) because that's the one Jupiter Lend's devnet market accepts.
- **Honest caveat:** the pool is an option *buyer*. Most rounds expire worthless, so the pool loses the premium it paid; it wins on big moves (a crash pays out on puts, a rally on calls). Max loss per round = premium paid. Returns are lumpy. It's a backstop, not the main liquidity.
- **Real-world pitch answer:** professional makers bid and hedge on Drift perps. This is the same pattern as Leaps and Rysk.

## 11. Agent desk — 2 AI roles: GLM proposes, Clef judges, the program enforces

| Role | Model | Job | Decides |
|---|---|---|---|
| **Quant** | GLM 5.3 + code tools | Calls tools, proposes one round (or "skip") with a rationale | **Expiry** (next std epoch by the §6 distance bands; quick epochs for quick plans), **size this round** (partial fills to ladder into the goal), **strike** (only if the user unlocked it, and only in the user's favour), **premium start/floor** within the pricer's range, **skip** (event risk, thin venues, premium below the user's minimum) |
| **Risk** | Cloudflare Clef (typed probabilities); GLM strict-JSON fallback | Judges the proposal on **risk only**: event calendar, vol regime, venue dispersion, user fit, rationale consistency. **Is not given the plan bounds** — bounds are the chain's job, so an out-of-bounds proposal can reach the program and be rejected on-chain | Approve / adjust (one Quant retry) / **veto** |
| **Card renderer** | code | Plain-English card + memo from the final proposal and tool outputs | Nothing |
| **Keeper** | code | Submits the desk's proposal **as-is** via `open_round`; sends samples / resolve / withdraw / unwind | Nothing — executes only |

**Why the LLM isn't decorative:** a formula can price one option; the desk decides *which* option to sell this cycle across a multi-week goal — ladder size vs. remaining goal, longer expiry before a known event or skip it, whether today's premium beats the user's minimum enough to be worth locking capital, and when to flip to the exit side. Every decision and every rejection is in the memo, hashed on-chain.

**Rules**
- LLMs never do math. All numbers come from tools.
- Memo = canonical JSON → sha256 → `Round.memo_hash`. Full memo in Supabase (no Arweave).
- The program enforces the user's limits even if the agents misbehave. The keeper never pre-filters, so every on-chain rejection is real.
- Between rounds, the desk reconvenes: roll, change expiry/size, skip, flip side (wheel), or stop because the goal was met.

**Tools:** `get_plan`, `get_spot`, `price_grid`, `fill_probability`, `lend_apy`, `venue_dispersion`, `spot_moves`, `event_calendar` (static curated JSON). Details in `BUILD.md` §5.

## 12. Assets & environments

- **Assets:** **SOL, BTC** on devnet (details below). SOL is built first; BTC is a config entry after SOL works end to end. **No JUP:** no venue lists JUP options (re-checked live 2026-10-05: Deribit, OKX, Bybit, Binance), so it could only be model-priced — breaks the real-data rule.
- **Budget: ~$0. Devnet only.** No mainnet, no Surfpool needed. (User constraint, 2026-10-05; program is unaudited.)
- **What's real on devnet:** our program, Jupiter Lend (USDC + WSOL markets), Pyth prices, CEX options data, Circle devnet USDC, devnet SOL. **What's ours:** two maker bots and the first pool deposit — real participants using the same public instructions anyone can call (`take_round` from the `/maker` page, `pool_deposit` from `/pool`). **No mocks anywhere** (decision 2026-10-05).
  | Asset | Devnet token | Jupiter Lend on devnet | Option pricing |
  |---|---|---|---|
  | **SOL** | real devnet SOL / WSOL | ✅ WSOL market | **Market-priced**: Deribit/OKX/Bybit/Binance |
  | **BTC** | our test mint `tBTC` (8 decimals, we're mint authority) | ❌ (sell-side collateral sits idle) | **Market-priced**: all 4 venues list BTC options |

  Spot and settlement prices for both come from real Pyth feeds (SOL/USD, BTC/USD — confirm feed IDs at kickoff). Build order: **SOL buy + sell end to end first**, then BTC (a config entry + maker-bot config).
- **Quick plan (opt-in, labelled):** 10-minute rounds, 100 s sampling window — same program, same instructions, real Pyth and Lend. No venue lists 10-minute options, so its pricing uses the nearest listed expiry's IV (flat vol), **labelled "quick-plan pricing"**. A 10-minute option pays cents, so show the real amount **plus** "a 1-day round would pay ~$X" — never an annualised APY. **Normal plans use daily+ expiries priced directly from listed CEX options.**

## 13. Demo script (screen recording, ≤ 3 min — the whole pitch; full script in docs/DEMO-SCRIPT.md)

1. Beginner picks **Buy cheaper → SOL → types a price just under spot (demo) → 20 USDC**; two-scenario confirm (filled / not filled + crash case).
2. Desk card appears; "Why this?" shows Quant's tool calls, Clef's probabilities ("86% approve, event risk low"), and the memo hash.
3. One signature → USDC goes into Jupiter Lend as jlUSDC (explorer link).
4. Auction: 2 maker bots compete, one takes it, premium arrives in the wallet.
5. Expiry: Pyth samples land bucket by bucket → filled (escrows swap: user gets SOL at exactly the strike) **or** not filled (USDC + premium + yield back). Record several takes; use whichever happened — both are honest.
6. `/desk` feed: a **real** on-chain rejection from the running system (e.g. `StrikeOutOfBounds` / `PremiumBelowUserMin` / `ExpiryOutOfBounds`), with tx link, then the accepted retry. Say plainly: "the agent is allowed to try; the program decides." *(Status 2026-10-06: the on-chain rejections so far are 1× `AuctionParamsInvalid` and 3× timing (`OutsideAuctionWindow` ×2, `StalePrice`); none of the bound examples above yet, and no accepted retry recorded. README §5.)*
7. Desk reconvenes → flips to "Sell higher" at the user's exit target (wheel).
8. "vs Jupiter" panel: Trigger $0 · Earn on Recurring $X · us $Y.

## 14. Scope (decided 2026-10-05: full scope)

**Everything ships:** buy (put) + sell (call) rounds and the wheel flip; SOL, BTC; shareable Blink; backstop pool; Clef Risk; 4-venue pricing; `/`, `/earn`, `/plan/[id]`, `/desk`; real Jupiter Lend CPI; unwind path; live URL. Build order: **SOL buy loop, then SOL sell loop** (both recorded by H26), then the rest in `BUILD.md` Phase 7 order.

**Emergency order only** (if a phase exit is missed by > 2 h — not a plan to cut): BTC → Blink → LP share UI → Lend CPI swapped for the client-side jlUSDC plan B (`BUILD.md` §3.6). Never cut: SOL buy + sell loops, real Pyth settlement, desk + on-chain rejection, unwind.

**Biggest technical risks, in order:** (1) Jupiter Lend CPI account wiring, (2) oracle sampling + settlement split across transactions, (3) CEX IV interpolation. No mocks: test against the **real programs cloned into a local validator** (Jupiter Lend, Pyth receiver, Wormhole accounts) before devnet, so every test runs real code.

## 15. How we beat the competition (pitch)

| | Jupiter Trigger | Jupiter Earn on Recurring | Meteora DLMM Limit Order | Leaps Finance | **Us** |
|---|---|---|---|---|---|
| Paid upfront, filled or not | ❌ | ❌ | ❌ | ✅ | ✅ **premium ~0.8–1%/week** (5% below spot, weekly, after fee — rough) |
| Earns while waiting | ❌ | ✅ Lend (~0.09%/week) | ✅ swap fees (only if volume crosses your bins) | ❌ | ✅ Lend on the collateral (~0.09%/week) |
| Fills | on touch | DCA schedule | on touch | at expiry | at expiry, at exactly the target |
| Works for "buy at my price" | ✅ | ❌ (DCA only) | ✅ | ≈ (manual options) | ✅ |
| Beginner language | ✅ | ✅ | ≈ | ≈ (Buy/Sell + slider + APR; options terms in docs) | ✅ plan sentence + payoff slider |
| Multi-round goals, auto-managed | ❌ | ❌ | ❌ | ❌ (manual re-open) | ✅ |
| Change plan between rounds | ✅ (cancel) | ✅ | ✅ | ❌ (locked to expiry) | ✅ `update_plan` |
| AI with on-chain guardrails | ❌ | ❌ | ❌ | ❌ | ✅ |
| Who can take the other side | — | — | — | whitelisted pro makers (presumably) | anyone (`/maker`), anyone can LP (`/pool`) |
| Real-world status | mainnet | mainnet | mainnet | **mainnet, audited** | devnet, unaudited |

**One-liner vs Leaps:** "Leaps sells you one option and leaves you to manage it; Bide takes a price and a deadline, runs the whole sequence with an AI desk the Solana program can overrule, earns Jupiter Lend yield on the same collateral, protects you with a CEX-anchored on-chain floor, and lets anyone be the maker, the LP, or share the plan as a Blink."

**Answer to "why not Meteora's limit order?"** It's fill-on-touch with no upfront payment; ours pays upfront and fills at expiry. Complements, not competitors. **Premium is ~10× the Lend yield** — Lend is where the collateral lives, not the headline.

## 16. Prep allowed before kickoff (no project code)

Public tools, accounts and reading are fine under the rules. Project code is not.

- [ ] **Toolchain:** Rust, Solana CLI, Anchor, Node/pnpm installed and working.
- [ ] **Accounts / keys:** Z.ai (have), Solana devnet RPC (Helius free tier), Pyth Hermes (public). Circle faucet for devnet USDC. (Jupiter Portal key only if we add a mainnet swap later.)
- [ ] **CEX APIs:** confirm the 4 public options endpoints respond from your network (no keys needed).
- [x] **Wallets created 2026-10-05 — see `WALLETS.md`.** Original plan: **Wallets (create now — faucets are rate-limited, so start collecting early):** fresh devnet-only keypairs, never reused on mainnet, stored in a gitignored `keys/` folder:
  - `deployer` (program upgrade authority + pool authority) — needs several SOL for program deploy rent
  - `keeper` (agent key for `open_round`; also sends settlement + `pool_take_round` txs) — ~1 SOL for fees
  - `maker-1`, `maker-2` (+ optional `maker-3`) — SOL for fees + SOL/USDC to escrow
  - `demo-user` — a Phantom wallet switched to devnet, for the screen recording
  - Funding: `solana airdrop` / faucet.solana.com for SOL, faucet.circle.com for devnet USDC. Toolchain already installed: solana-cli 3.1.10, anchor-cli 1.0.2, Node 25, pnpm.
- [ ] **Budget: $0 target.** Free tiers only (Helius, Vercel, Supabase); worker on the user's own ECS VM. The only possible cost is Z.ai GLM usage.
- [ ] **Hosting:** frontend (Vercel), agents + keeper + pricing service (own ECS VM), DB for plans and memos (Supabase).
- [ ] **Read:** Jupiter Lend CPI + SDK docs, Pyth Solana receiver (price updates), the 4 CEX option endpoints.
- [ ] **Try Leaps' app** to confirm the gaps we're pitching against.
- [ ] **Deck template** in .ppt/.key, ready for an embedded screen recording.

## 17. Open questions / to verify at kickoff

- [x] **Team size and lanes — answer at H0** (answered 2026-10-05: orchestrator + Opus lane agents, decision log) (who owns P / W / A / F in `BUILD.md` §8). Full scope is decided; advisors estimate it at ~3× a solo 36 h, so the lane owners matter more than anything else on this list.
- [x] Thetanuts: user confirmed it's fine — different product, stack and AI layer.
- [x] Name: **Bide**.
- [x] Pyth TWAP: removed 6 Feb 2026 → bucketed sampling is the primary design (§7).
- [x] SOL/BTC/ETH options listed on Deribit/OKX/Bybit/Binance — use all four (pricing rule in §6). To verify at kickoff: exact Deribit SOL instrument names, rate limits, and which expiries exist.
- [x] Jupiter Lend devnet USDC market exists — yes (Circle devnet USDC) + WSOL market.
- [ ] Try the Leaps app: confirm their weak spots (manual? single round? lend yield?).
- [x] Call round settlement: physical delivery (§8) — exercised → user gets `K × Q` USDC, maker gets SOL.
- [x] Memo storage: Supabase + on-chain sha256 (no Arweave).
- [x] Maker bots funded from our devnet wallets (`WALLETS.md`).

## 18. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-05 | Main track + Solana track | Fits the build; Solana program is core |
| 2026-10-05 | Kairos-style (paid limit orders) over Zend (no-liquidation loans) | Stronger demand evidence (Binance DI 500K users, Rysk $1.2B notional vs MYSO ~$1M TVL); fits Jupiter Lend instead of competing with it |
| 2026-10-05 | Jupiter Lend (jlUSDC) for collateral yield, ~~Jupiter Swap for delivery~~ (superseded: physical delivery) | Jupiter integration; Lend has CPI + devnet programs |
| 2026-10-05 | ~~Mainnet with small amounts~~ → **superseded:** devnet (hosted) + Surfpool fork (recorded demo), $0 budget | User doesn't want to spend real money; Surfpool still runs the real Jupiter programs |
| 2026-10-05 | ~~Multi-agent desk on GLM 5.3 / 5.3 Flash~~ (superseded: 2-role desk, GLM + Clef); LLMs never do math | User has Z.ai keys; judges would catch LLM-made pricing |
| 2026-10-05 | ~~Settlement: Pyth TWAP~~ (superseded: Pyth TWAP removed Feb 2026) | — |
| 2026-10-05 | We create the options market via a Dutch auction | No Solana options order book to pull bid/ask from |
| 2026-10-05 | Beginner UX: no options jargon in the main flow | Target user "just wants to earn" |
| 2026-10-05 | ~~Strike = user's target ± small agent nudge~~ (superseded below) | Keeps "name your price" while letting the desk improve premium; range enforced on-chain |
| 2026-10-05 | Pricing: hidden Dutch auction + backstop LP pool at the floor | One click for users, competitive price, pool guarantees fills when makers are absent |
| 2026-10-05 | No fill (pool at capacity) → stay in Jupiter Lend and retry next window | User always earns something; no refund churn |
| 2026-10-05 | User asked for full spec scope | ~~cut list in §14 is the safety valve~~ (superseded: full scope confirmed, emergency order only) |
| 2026-10-05 | Reference pricing from live CEX options data (superseded by the pricing-rule row below) | SOL/BTC options are listed on Deribit, OKX, Bybit, Binance; gives real bid/ask anchors instead of guessed vol |
| 2026-10-05 | Pricing = median mid-IV across Deribit/OKX/Bybit/Binance for fair; ~~highest~~ (superseded: median) venue bid-IV × 0.9 for the floor; ≥2 fresh venues required | Real data only; median resists stale/thin quotes; best bid protects the user |
| 2026-10-05 | ~~Drop JUP; assets = SOL, BTC (+ETH optional)~~ (superseded below) | No CEX lists JUP options, so it can't be priced from real data |
| 2026-10-05 | Never deploy to mainnet with real funds | Program is unaudited; hackathon rules don't require mainnet (only a repo, live URL or hosted demo, slides) |
| 2026-10-05 | ~~Jupiter Swap via Router path `/swap/v2/build`~~ (superseded: no Swap in settlement) | Only path that returns modifiable instructions for CPI / our own settle tx |
| 2026-10-05 | **Devnet only** — drop Surfpool and mainnet entirely | User wants $0 spend; unaudited program |
| 2026-10-05 | **Physical delivery settlement** (maker escrows SOL/USDC at take) instead of cash-settle + Jupiter Swap | No swap needed on devnet, fill at exactly the strike, no maker default, nothing mocked |
| 2026-10-05 | Jupiter integration = Jupiter Lend on both sides (USDC + WSOL markets, verified live on devnet) | Real Jupiter tech in the core flow without needing Swap |
| 2026-10-05 | Name: **Bide** | User's pick |
| 2026-10-05 | ~~Devnet assets: SOL, BTC (tBTC), JUP (tJUP); JUP model-priced~~ (superseded: JUP dropped) | User wants more tokens; JUP has no listed options anywhere |
| 2026-10-05 | Pool and makers funded with free devnet tokens only (Circle devnet USDC, devnet SOL, our tBTC) | $0 budget; Circle USDC required for Jupiter Lend devnet market |
| 2026-10-05 | Thetanuts concern closed | User confirmed: different product, stack and AI layer |
| 2026-10-05 | ~~Host the worker on Cloudflare (Workers + one Durable Object alarm loop)~~ (superseded: Railway, then own ECS VM) | User prefers Cloudflare; single alarm keeps it inside the free plan |
| 2026-10-05 | Settlement oracle = bucketed median of Pyth samples; settle split into `post_sample` → `resolve_round` → retryable `withdraw_collateral` | Pyth TWAP removed; anti-cherry-pick; Lend limits can't freeze maker escrow; tx size |
| 2026-10-05 | "Lock my exact price" ON by default; nudges only in the user's favour | Nudging up for premium = worse buy price (bait-and-switch) |
| 2026-10-05 | Floor from **median** venue bid-IV; on-chain `floor ≤ fair ≤ start` | One stale bid must not set the floor |
| 2026-10-05 | User-signed min premium mandatory in `Plan`; pool caps as % of notional + ~~per-epoch~~ spend-window cap (renamed: avoids confusion with `Epoch`); spot-move guard in `take_round`; `pause_plan`, `rotate_agent`, max rounds/day | Protection must not depend on the hot agent key |
| 2026-10-05 | Copy: "checked once at expiry, not on touch"; show missed-dip + crash scenarios; drop "same as a limit order" and "pool has an edge" | Both were false |
| 2026-10-05 | Agent desk = Quant + Risk (LLM, Risk veto binding) ~~+ Intake only for free text~~ (superseded: free-text intake cut — no Intake model); card rendering in code | A separate intake step duplicated the form and a separate card-writing LLM only formatted text; fewer LLM hops = less latency and fewer hallucination points; every remaining LLM makes a real decision |
| 2026-10-05 | Detailed phase-by-phase build plan written to `BUILD.md` | Start building at kickoff without re-planning |
| 2026-10-05 | Dual model: GLM 5.3 proposes (Quant), **Cloudflare Clef** judges (Risk, typed probabilities), program enforces; ~~GLM 5.3 Flash only for free-text intake~~ (superseded: free text cut); not Jev | Clef returns calibrated typed decisions fast and cheap — right tool for a veto gate; GLM needed for generation/tool use; Jev is limited early access |
| 2026-10-05 | Clef backend: Workers AI hosted by default; local Clef-flash (official joint-schema-head path) optional for dev; no Intake model in v1 (form only) → exactly 2 AI models / 2 AI roles | Live URL must work without the laptop; 27B doesn't fit 24 GB; GGUF/Ollama builds lose the decision head |
| 2026-10-05 | ~~**Worker on Railway**~~ (superseded: own ECS VM) (one Node process), laptop hot fallback; Clef still via Workers AI REST | workerd + web3.js/Anchor rough edges; hosting isn't judged; one runtime for all loops |
| 2026-10-05 | Add permissionless `unwind_round` ~~after `expiry + grace`~~ (superseded: only when the epoch is Failed); `resolve_round`/`unwind_round` release pool `open_notional`; withdraw pays `min(notional, redeemed)` (now via Lend withdraw-by-amount) | Keeper death must never lock funds; program, not keeper, is the guard |
| 2026-10-05 | Risk (Clef) is **not** given plan bounds; Quant may propose out-of-bounds; rejections come from the running system, not a staged script | Otherwise Risk vetoes it off-chain and the on-chain rejection never happens; "staged?" must have an honest answer |
| 2026-10-05 | Quant decides expiry (allowed set), per-round size (laddering), premium bounds, skip, flip | Gives the LLM real decisions; answers "what does the AI do a formula can't" |
| 2026-10-05 | Maker spreads randomised per round + per-bot inventory limits | Deterministic spreads meant maker-1 always won |
| 2026-10-05 | Demo: strike = ~~spot − 0.3–0.5%~~ spot − 0.05–0.15% (superseded by the $0.10 tick row below); no annualised APY; show "1-day equivalent" premium; record several takes | 6-min ATM premium ≈ cents; annualised figure was absurd; both outcomes are honest |
| 2026-10-05 | Premium paid to the user's USDC ATA (idempotent create, maker pays rent), not a claim PDA | Simpler; same safety |
| 2026-10-05 | Close Pyth price-update accounts after each `post_sample` | ~10 updates/round × rent would drain the keeper |
| 2026-10-05 | User picks a deadline ("by when": 1 wk / 1 mo default / 3 mo / date, max 6 mo); permissionless `expire_plan` returns funds after it | "Buy X at $Y by Z" is the natural beginner sentence; deadline must not depend on our keeper |
| 2026-10-05 | ~~New `faucet` wallet for judge test funds~~ (superseded: removed — we demo it ourselves) | — |
| 2026-10-05 | 2 maker bots (maker-3 optional via config) | Randomised spreads already show real competition with 2; a third only adds on-screen busyness |
| 2026-10-05 | **Real product, no mocks.** Product defaults (daily expiries, CEX-priced); 10-min "quick plan" is an opt-in labelled feature on the same code path; LP pool open to anyone with share mint + withdraw; `/maker` page lets any wallet take auctions; tests use real programs cloned into a local validator | User wants a fully working product on devnet, not a hackathon-fitted demo |
| 2026-10-05 | Hedged options pool (perp hedge on Drift) = v2, not in this build | Removes reliance on outside makers long term; too large for 36 h on top of full scope |
| 2026-10-05 | Platform fee = 10% of premium (`Config.fee_bps`, cap 20%) → `revenue` wallet; user min-yield checked after fee; shown net in UI | Revenue without being the counterparty; precedent: options vault performance fees |
| 2026-10-05 | Round length by distance to target (≤3% → 1–2d, 3–8% → ~1w, >8% → 2–4w, capped by deadline) | Daily rounds on far targets pay ~0 |
| 2026-10-05 | No judge faucet; fee recipient = demo-user on devnet | User demos it themselves; devnet fees have no value, so no separate wallet needed |
| 2026-10-05 | **Jupiter Lend only; no Meteora** (not stacked, not a v2 mode) | Meteora already ships a native fee-earning DLMM Limit Order — building it = cloning a partner feature. Our product is premium-upfront, fill-at-expiry. Same USDC can't back an option escrow and sit in bins; devnet has no swap volume. (Fable 5.1 review) |
| 2026-10-05 | **Drop JUP** (assets = SOL, BTC); **buy + sell both core** (both loops recorded by H26) | No venue lists JUP options (checked live) → model-priced only; user wants both directions as the core product |
| 2026-10-05 | Add a **shareable Blink** (Solana Action) that creates a prefilled plan | Distribution + innovation: a "paid limit order" you can share from X; reuses `create_plan` |
| 2026-10-05 | Leaps triage (Fable 5.1): add `update_plan`, payoff slider, `/auctions` tape, P&L vs limit order, Telegram notifications; Leaps column with verified facts; desk shows rejection counter + visible skip/ladder; `/pool` kept minimal (deposit/withdraw + risk note) | Leaps already ships the instrument on mainnet with pro makers + audit; we win only on what wraps it |
| 2026-10-05 | **Epochs**: rounds join a shared epoch per asset + expiry (daily / weekly / monthly at 08:00 UTC; quick plans every 10 min); Pyth samples + settlement once per epoch; new `Epoch` account, `open_epoch`, `resolve_epoch` | Makers can quote batches (Leaps/Ribbon/Deribit pattern); ~N× fewer keeper txs and rent; one settle price per epoch |
| 2026-10-05 | Recording demos **SOL only**; BTC built after both SOL loops are solid, not on screen; free-text goal input **cut** | SOL is the only fully real asset on devnet; free text duplicated the form and added a third model |
| 2026-10-05 | **Worker on the user's ECS VM** (8 GB) instead of Railway; pm2/systemd + Caddy HTTPS | Already owned, always on, no trial limits; must be outside mainland China so exchange APIs are reachable |
| 2026-10-05 | **Final Opus 5.5 triage:** withdraw-by-amount, `pending_settlement`, unwind only on Failed epoch, Epoch kind in seeds, auction-window constants, call branch, single-Lend-market wheel, pool fields/NAV, Pyth Full + push-feed spot | Closes the close-before-pay race, unwind front-running, quick/std epoch PDA collision and share-math drift; calls + wheel fully specified; makers/LPs never post VAAs. Detail in `BUILD.md` §3.2–3.3 |
| 2026-10-05 | Kept as-is after triage: no secret-scanner step; worker on the user's ECS VM (Malaysia); `fee_recipient` = demo-user on devnet (recording shows after-fee figure on `/plan`); full scope; free text cut; no JUP; SOL-only recording | User decisions |
| 2026-10-05 | Devnet addresses verified on-chain (BUILD §3.7). Jupiter Lend CPI built from IDL (SDK is mainnet-only). Pyth: use the upgraded program set; devnet push feeds update ~5 min → `max_spot_age_secs` 600 on devnet; Hermes needs an API key; Plan A = post `hermes-beta` updates, Plan B = push-feed-only sampling (6×300 s std, first-update-after-expiry quick) | Research subagent findings; oracle plan must match what devnet actually provides |
| 2026-10-05 | Jupiter triage: **use** Lend Earn CPI (core, official docs list devnet ids; PDA-depositor pattern proven by marginfi-v2 on mainnet), on-chain exchange-rate reads, Lend `/earn/tokens` (mainnet APY, labelled reference) + Price v3 (spot reference) — keyless 0.5 RPS, cached in the worker; **Docs MCP** for the build agent. **Skip** Trigger/Recurring APIs (auth + mainnet-only; use as cited pitch facts), Swap/Ultra, Portfolio, Tokens, CLI, Trading MCP, the Lend SDK on devnet. Stale 4.65% APY replaced by live fetch | No Jupiter REST API has a devnet mode; Lend programs do |
| 2026-10-05 | **Full scope confirmed** by user; §14 becomes an emergency order only; score plan in §22 | User: "I won't fall behind, implement all" |
| 2026-10-05 | **Kickoff confirmed 4 Oct 2026** (user); build started 2026-10-05 ~14:45 UTC. Remaining std auction windows: 6 Oct and **7 Oct 08:00 UTC** (hard milestone) | HACKATHON.md "6–8 Oct" is the event, not the build start |
| 2026-10-05 | **Team:** orchestrator + Opus 5.5 lane agents (P program, P2 oracle verify, W worker, A desk, F frontend) in one working tree with disjoint dirs (no worktrees — no commits yet); **Fable 5.1 advisor** at decision points; lane findings land in `notes/<lane>.md`, orchestrator merges into SPEC/BUILD | User request; parallel lanes per HANDOFF §0.4 |
| 2026-10-05 | **Program tests on LiteSVM** (npm `litesvm`) loaded with the real devnet binaries + accounts (dumped to `tests/fixtures/`), instead of `solana-test-validator` clone | Program logic is wall-clock gated (08:00 UTC windows, buckets); LiteSVM can set the Clock. Still real programs, no mocks |
| 2026-10-05 | Desk (A lane) rules: Risk runs only on `open` proposals; after an adjust-retry Risk judges again (veto stops, no second retry); **all Risk backends down → fail closed (no open_round)**; `explanation_ok` = Clef `noul`; card shows an after-fee pay **range** (floor→start) since the winning bid is unknown; tools add computed fields (ladder sizes, distance band, user-min floor after fee) so the LLM does no arithmetic, and never filter by plan bounds. Z.ai: tools OpenAI-style, `tool_choice` auto only, `response_format` json_object only → zod + one repair turn; GLM-5.3 always thinks (latency). Known gap: Quant's free-text rationale reaches Risk unscrubbed | BUILD §5 left these unspecified; fail-closed is the safe default |
| 2026-10-05 | **Pyth Plan A confirmed** with **mainnet `hermes.pyth.network`** (env `PYTH_HERMES_URL`): its VAAs verify Full on devnet `rec2…` (guardian set 1, 3 sigs), latest and historical. ~~Plan B (push-feed-only sampling)~~ dropped. `hermes-beta` not used (our key isn't entitled, 403) | P2 verified on devnet with real txs (`notes/oracle.md`); supersedes the Plan A/B row above |
| 2026-10-05 | **Bucket rule:** accept iff `prev_publish_time < bucket_start ≤ publish_time ≤ bucket_start + tolerance`; tolerance **Quick 2 s, Std 10 s**; PriceUpdateV2 must be owned by `rec2…` and Full | Unique first update per bucket → no cherry-picking among the 3+ prints a plain window allows. Hermes is 1 Hz gap-free. The receiver does no age check, so this window is the only defence |
| 2026-10-05 | ~~**Devnet push-feed spot age = 180 s**~~ (superseded 2026-10-06: 300 s) (`Asset.max_spot_age_secs`; mainnet 30) | Upgraded push feeds update every ~60–70 s (the "~5 min" figure was the old `rec5…` set); 180 s survives one missed update. Supersedes 600 s |
| 2026-10-05 | **SOL `strike_tick` = $0.10** (`100_000`) | A $1 tick ≈ 5σ for a 10-min quick epoch (σ√T ≈ 0.17%), so "spot − 0.3–0.5%, ~50/50 fill" was impossible (live: K = spot−0.5% priced at ~$0 → `PremiumBelowUserMin`). Recording strike becomes spot − 0.05–0.15% |
| 2026-10-05 | 10-vol-point spread filter **kept as-is** for now (open choice for the user) | Live data: 1-day std rounds are often unpriced (spot−5%: 0 venues pass); the desk then picks weekly. Widening to 20 vol points for T < 2 d is the alternative |
| 2026-10-05 | Pyth receiver ixs **hand-built** in `scripts/pyth/post.ts` (worker copy `worker/src/pyth/post.ts`); not the JS SDK | `@pythnetwork/pyth-solana-receiver` 0.16 breaks at runtime under Node 25 (jito-ts → web3.js 1.77 export error) |
| 2026-10-05 | **Vault ownership:** every plan token account (USDC staging, fToken, asset vault) owned by data-less `["lend_auth", plan]`; pool vaults + share-mint authority `["lend_auth", pool]`; escrow authority = Round PDA | Lend needs a writable data-less PDA signer that owns both token accounts (marginfi pattern); verified on LiteSVM with real devnet Lend |
| 2026-10-05 | **Lend rounding:** `create_plan` deposits principal + 10 base units (`LEND_DUST_BUFFER`); withdraw pays `min(owed, received)` if the position falls short; close/expire skip redeem below 1,000 base units; `liquidity_program` passed writable | Withdraw-by-amount burns shares rounded up → maker was 1 unit short; Lend rejects tiny ops (6028); deployed devnet Lend needs `liquidity_program` mut despite its IDL |
| 2026-10-05 | Program interface as built: `init_config(agent, fee_bps, fee_recipient)`; new `update_asset`; `Asset.spot_feed` pins the push-feed account, `Asset.lend_f_token_mint`; `Epoch.bucket_tolerance_secs` u32 + `grace_secs`; Lend accounts as remaining accounts (13 per market); `cancel_round` = owner any time in Auction / agent after pool window opens / anyone 60 s later. `update_plan`, `flip_plan`, pool ixs: **layout frozen, `NotImplemented`**, shipped via upgrade | P lane deviations (`notes/program.md`); IDL frozen so W/A/F can build against it |
| 2026-10-05 | Worker pricer/keeper rules: Deribit bid/ask IV implied from prices (Black-76); Binance forward = index spot; anchor clamp order start→3·floor, raise floor only if start < fair; sample only epochs with Live rounds; pre-open epochs (2 dailies, 4 Fridays, monthly; 3 quick); `open_round` with skipPreflight; off-chain failures (`EpochNotFound`, `WindowMissed`, `Transient`) never count as on-chain rejections; quick desk starts 90 s early, late results not submitted; maker vol tilt ±2%; `telegram_links` not anon-readable | W lane (`notes/worker.md`): avoid ~700 ticker calls; honest rejection counter; ±5% tilt made one bot win ~98% |
| 2026-10-05 | **Fable 5.1 program review → fixes before the 7 Oct window:** escrow-donation lock in `cancel_round` (sweep then close), `pool_take_round` deadline + epoch Open check, min round notional 1 USDC + Lend min-redeem in `withdraw_collateral`, pool receivable between resolve and withdraw (NAV hole), Wheel `close_plan` must include the asset vault, pool first-depositor virtual offset. **Accepted as known limits:** fee change between open and take (admin-only), poster can omit ≤ 2 samples (anyone may post within grace), tBTC pool calls (tBTC not enabled) | Each one broke "no stuck funds" or let the pool be drained; no account-layout changes so devnet upgrades in place |
| 2026-10-05 | First devnet loop (quick buy) **did not settle**: maker took it, then the keeper froze 28 min on one RPC request with no timeout, missed every sample → epoch Failed → keeper **unwound** the round (unwind proven on devnet). Fixes: per-request RPC timeouts + fallback RPC + per-loop connections + watchdog; sampling gets its own 1 s loop; quick epochs pre-opened only when a quick plan exists. Program upgraded with the Fable fixes (slot 507875135) via Helius `--use-rpc` (public RPC rate-limits deploys with 429) | Worker robustness, not program logic, was the failure; std window can't depend on one hung socket |
| 2026-10-06 | **Std auction default 300 s** (quick stays 30 s); program range unchanged (Std 10–1,800 s) | 30–60 s suits our bots but is too short for real market makers to react; std rounds are batched in the 30-min 08:00 UTC window, so 5 min still fits. Start ×1.3 / floor ×0.9 stay as labelled judgment parameters |
| 2026-10-06 | **AI v2 (docs/ai-agents.md):** natural-language intake (GLM, user still reviews + signs), **two AI maker agents** with personas bidding in the Dutch auction (bid clamped to [floor, start], deterministic fallback, hashed thesis), **reflection memory** after each epoch feeding the next desk/maker run (may tune auction length, start/floor within the pricer range, expiry, size, skip — never the user's bounds). Supersedes the 2026-10-05 "free-text intake cut" row. Solana dev skill not installed (it targets Anchor 1.1 / Kit / web3.js v3; switching now = rewrite). Solana-track guide requirements recorded in HACKATHON.md | User wants AI to be a bigger, real part; agents trading through the program is the strongest true "why Web3" story; no program change needed |
| 2026-10-06 | AI v2 revised after Fable review: **no LLM reflection** (deterministic `recent_outcomes` instead — n is tiny and our own makers fill quick rounds, so LLM "lessons" would learn our RNG); makers output spread %, not base units; per-epoch stance; P&L ledger shown; makers blind to desk memo/bounds. Pitch: "Three AI agents — a seller's desk and two buyer makers with opposing theses — negotiate every round in a Dutch auction, and the Solana program decides what's allowed and who gets paid." | Avoid a "staged?" moment; LLMs never do math |
| 2026-10-06 | AI v2 build details (notes/agents.md): maker stances decided **240 s** before an epoch's auction window (`MAKER_STANCE_LEAD_SECS`; earlier than the desk's 90 s so stance calls don't sit in the serial GLM queue ahead of the desk, which also has priority); a round whose stance is still pending waits ≤ 15 s, then uses the deterministic fallback; **no LLM bid when fair < floor**; LLM bids clamp to [floor, min(start, fair)]; maker GLM calls capped at 30/h (`MAKER_LLM_MAX_PER_HOUR`); `recent_outcomes` may inform auction length, expiry, size and skip only — premiums still come from the price grid; the new tables are in initRepo's required list, so an un-migrated Supabase falls back to memory | LLMs never do arithmetic; latency/quota bounded; no silent DB write failures |
| 2026-10-06 | **Telegram notifications removed** (worker `notify` module, `/plan` button, `TELEGRAM_BOT_TOKEN` / `NEXT_PUBLIC_TELEGRAM_BOT`) | User decision: not needed for the demo, and the `/start <plan>` linking had an authorization bug (anyone could link any plan). Plan events are still derived and logged by the mirror; the `telegram_links` table stays in old migrations but is unused. |
| 2026-10-06 | **UI restyle: dark-first terminal style** (Inter, blue-grey neutrals, one evergreen-mint accent, swap-card inputs, compact tables), style language referenced from jup.ag (`app/design-reference.md`) | User asked for a less "vibe-coded" look. Bide keeps its own name, wordmark and voice; no Jupiter brand marks. See `app/brand.md`. |
| 2026-10-06 | **6 Oct 08:00 UTC std window outcome:** sell (call) round `5Ccfmg…` on std plan `8kaDR2Sn…` (K $121.10) opened 08:03:10, taken by maker-2 08:08:14 → **settles 7 Oct 08:00 UTC** (only round on that epoch). Buy (put) round `4vsDuo…` on `GZyrcLHj…` opened 08:02:10 and was **cancelled untaken** at pool_open 08:08:13: both makers had bids above the floor but held because the push feed was 227 s old (limit 180 s), and no pool existed | Honest record of the only std window before the demo; drives the next four rows |
| 2026-10-06 | **Devnet SOL `max_spot_age_secs` 180 → 300 s** (`update_asset`, tx `2RnLpFaa…`, 09:56 UTC); `init-devnet.ts --update` now changes only that field. Supersedes the 180 s row | Feed gaps of 227–320 s blocked takes and opens. **Weaker spot guard** (5 min old spot vs mainnet 30 s) — stated in the README limits |
| 2026-10-06 | **Backstop pool initialised on devnet:** PDA `3vY4n9Wm…`, deployer = authority + only LP, 25 USDC + 0.5 WSOL; caps 150 bps of notional per premium, 40 USDC open notional, 50% utilisation, 2 USDC per 86,400 s (`scripts/init-pool.ts`) | Without a pool every untaken round was cancelled (10 of 14 rounds 06:11–10:20 UTC) |
| 2026-10-06 | **Keeper cancel timing (finding, program unchanged):** `take_round` is only legal until pool_open (`AuctionOver` after) and `pool_take_round` only in `[pool_open, pool_open + 60]`, so delaying the cancel cannot save a round. Keeper: pool take only inside `[pool_open, pool_open + 57 s]`, holds (no tx) while the feed is older than limit − 15 s, cancels after the pool deadline or a non-retryable pool failure (before: a failing pool take retried forever). Makers log every stale-feed hold | Matches the program's actual windows; no silent stuck rounds |
| 2026-10-06 | **Maker quick pricing:** the maker stance reference grid for quick epochs = nearest OTM tick + one more (std stays ~2% / 5% OTM); a stance triggered by an open round also prices that round's strike | At ±2/5% a 10-min option has fair ≈ 0, so every quick stance was `pass` and every quick round went untaken |
| 2026-10-06 | **Worker liveness fixes:** `open_round` retried up to 3× on transient (non-program) failures inside the window; chained quick rounds (desk runs in the lead while the previous round resolves; keeper holds `open_round` until the plan is free); zombie `running` desk runs marked `abandoned` at startup; desk offered only epochs `open_round` can still target; quick horizon = ≤ 3,600 s for pricing tools; desk prompt states the auction_secs ranges (after an on-chain `AuctionParamsInvalid` for a 300 s quick proposal, 08:10:55; in code — deployed to the VM 2026-10-06 11:36 UTC (commit 4e6c5e8)) | Fable triage P0s and observed failures: one transient error lost a whole window; quick plans got a round every 20 min, not 10 |
| 2026-10-06 | **Security hardening (public routes + agents):** worker re-validates `/desk/preview` and `/intake` bodies with strict zod (unknown keys rejected, bounded numbers/strings), sliding-window per-IP + global rate limits, preview cache; app routes do the same checks early; **LLM queue**: keeper desk 0 → maker stances 1 → public preview/intake 2 in a low lane (1 in flight, bounded backlog → 429; high lane never waits behind it); bound values scrubbed from the Quant's rationale before Risk reads it; `/desk` counts only `status = rejected`; pm2 `max_restarts` 1,000,000 + exp backoff | Public LLM routes were a quota-burn / DoS vector; a judge preview could make the keeper miss a 60 s window; Risk must not see bounds even via the rationale |
| 2026-10-06 | **Demo-plan keeper built, NOT enabled** (`worker/src/demo/plans.ts`, opt-in `DEMO_OWNER_KEYPAIR`): keeps one quick buy + one quick sell plan (0.05 SOL, 4 h) near spot for a dedicated `demo-owner` wallet (`D1cMzVCa…`, funded 1.5 SOL + 15 USDC). Key not in the VM env. **Pending user decision**; manual replacement quick plans were also not created | All three quick plans filled by ~10:20 UTC (desk sizes each round at the full remainder), so no quick rounds run until a new quick plan exists |
| 2026-10-06 | **Z.ai key is a Coding Plan key** → `ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4` (verified live); Clef via Workers AI answering live; desk on since 05:13 UTC, first desk-opened round 06:00 UTC (`29YB1b3S…`, exercised) | Closes the Phase 0 VERIFY items for Z.ai and Clef |
| 2026-10-06 | **Intake: relative targets computed in code.** The intake model may return `target_offset_pct` (signed, at most ±30) when the user states a % move; the worker turns it into a dollar strike from live Pyth spot, snapped to the $0.10 tick (buy down, sell up). Stated patience is a desk/Risk preference only — it never picks the price. If the price is still undecided the /earn price field stays empty and flagged (no preset fallback) | Live test: "dips ~2%, I'm patient" showed the Patient preset ($105.50, ~−12%) — contradicting the user. The LLM still does no arithmetic |
| 2026-10-07 | **Stage pitch = one embedded video, ≤ 3 min (was ≤ 2 min video + ~3 min talk).** Deck is 3 slides (title, video, proof/end card); competitor table and business line become two text cards inside the video. `docs/DEMO-SCRIPT.md` rewritten to 3:00; `PITCH-SCRIPT.md` is now Q&A/reference | User confirmed the slot is 3 min, demo video only. The Solana guide (docs/Solana_Hackathon_Guide.pdf) requires no video — only a working demo a judge can run unassisted; the recording is a Main-track stage requirement |
| 2026-10-07 | **Pool NAV marks live pool options at intrinsic value** (codex_v2 P1). New `Pool` fields (appended, +32 B → 180 B): `put_open_size`, `put_open_notional`, `call_open_notional`, `call_open_size` = per-kind sums over LIVE pool rounds, kept in `pool_take_round` / `release_pool` (resolve_round, unwind_round). `pool_nav`: put leg = `max(spot × put_open_size, put_open_notional)`, call leg = `max(call_open_notional, spot × call_open_size)`; the rest of `reserved_usdc` / `reserved_wsol` = receivables of exercised rounds (USDC at face, WSOL at spot). `reserved_*` keep their meaning. `pool_take_round` now requires the SOL asset for calls too (`InvalidMint`; the pool only marks SOL). New admin-only **`migrate_pool`** grows the devnet v1 pool (148 B) in place, admin pays rent, v2 fields = 0; must run right after the program upgrade, before any pool instruction (they fail to deserialize a v1 account). No deposit/withdraw freeze while a pool round's epoch is Resolved: the pool can't see epochs without per-round accounts, and a counter-based freeze would block withdrawals indefinitely while the pool keeps taking rounds | Before: the escrow was valued at spot only, so an in-the-money pool option was under-valued, and between `resolve_epoch` and the permissionless `resolve_round` anyone could buy shares cheap and redeem after the receivable was booked (LiteSVM: +5.07 USDC on a 500 USDC deposit for a put, +7.75 for a call; after the fix −2 base units). The pool always ends with ONE of the two legs, so the max of both is ≥ what resolve_round books at the same spot. **Known limits:** max is per kind-sum, not per round (with mixed strikes the mark can still be below exact intrinsic — never below the old spot mark; exact with one live round per kind); time value ignored (NAV slightly low before expiry); marks use spot, not the settle price, so if spot crosses the strike between resolve_epoch and resolve_round the mark overstates by ≤ \|spot − strike\| × size until resolve_round runs (keeper runs it immediately; anyone can) |

## 19. Name

**Bide** (chosen 2026-10-05). "Bide your time": wait patiently for the right moment. Tagline idea: *"Name your price. Get paid until it fills."* (Avoid "get paid to wait" — Jupiter's campaign line.) Domains/handles not yet checked.

## 20. Startup path (beyond the hackathon)

**Tokens**
- **Now (devnet, fully working product):** SOL, BTC against USDC (SOL first). JUP and other tokens only once a venue lists their options. The program is asset-generic (config entry per asset), so more assets are a config + liquidity problem, not a code problem.
- **Mainnet v1:** SOL, BTC (cbBTC/wBTC), ETH against USDC — all have deep CEX options markets for pricing. Collateral idea: accept **liquid staking tokens (JitoSOL, JupSOL)** on the sell side so users keep staking yield on top of premium.

**Hedged options pool (v2 — removes the dependence on outside market makers)**
The pool takes the other side of every round and cancels its price risk by trading perps. Example: the pool buys a user's $110 SOL put (it gains if SOL falls), so it also buys a little SOL-PERP on Drift (which loses if SOL falls); the two roughly cancel, and the pool keeps the gap between the CEX-anchored floor it paid and the option's model value. Re-hedge as price moves. This is how Lyra/Derive and Premia work on Ethereum; nothing like it is live and liquid on Solana. Not in the hackathon build (perp hedging + mark-to-model NAV is its own project); the unhedged pool's risk is stated on `/pool`.

**Business model — Bide is the platform, not the counterparty**
- **Platform fee: 10% of every premium** (`Config.fee_bps`, admin-settable, capped at 20% in code). Taken on-chain inside `take_round` / `pool_take_round` and sent to the fee wallet's USDC ATA (**devnet: demo-user**; a dedicated wallet before mainnet). Users always see the amount **after** the fee ("you get $1.35"), and their minimum-yield setting is checked after it.
- **Later:** pool management fee (1–2%/yr) or performance fee (10% of LP profit); optional small cut of Lend interest.
- **We don't earn by trading against users.** Maker bots and pool deposits are risk capital that can win or lose; revenue comes only from the fee.
- **Rough scale (illustrative):** $10M in active plans × ~2%/month premium × 10% = ~$20K/month. Real only at scale; distribution decides it.

**What decides PMF (be honest about these)**
1. **Makers are the business.** Without real market makers bidding, the pool is our own balance sheet taking option risk. Leaps and Rysk work because pro makers bid. Recruit 2–3 makers before mainnet; the pool is a backstop only.
2. **Regulation.** Selling options to retail is derivatives activity in many places (US, Singapore, EU). In Singapore, options are capital markets products under MAS; offering them to retail needs licensing. Binance Dual Investment is restricted in several regions. Get legal advice early; plan geo-blocking.
3. **Audit before real money.** Non-negotiable for a program holding user collateral.
4. **The bad outcome must feel fair.** If SOL crashes to $80, a user who "bought at $110" will be unhappy, even though a limit order does the same. The UX must make this crystal clear before signing.
5. **Distribution.** Jupiter could add options themselves. Consider positioning as something that plugs into Jupiter (Trigger / Lend users) rather than only competing for the same users.

**Validate at TOKEN2049 itself:** ~25,000 attendees. Run 15–20 short user interviews ("do you use limit orders? would you take $X to wait?"), collect a waitlist, and talk to market makers at the event. That evidence is worth more than any feature.

## 21. Stress test (2026-10-05, Opus 5.5 + Fable 5.1 advisors)

**Applied above:** oracle redesign (§7), settlement split (§9), one-sided nudge + lock default (§6), median-bid floor (§6), honest copy (§5), pool reframed (§10), demo pricer (§12, now "quick plan").

**Also apply when building:**
- **On-chain protection independent of the agent key:** `Plan.min_premium_bps_per_day` (user-signed, mandatory) — program rejects any `open_round`/fill below it. Pool premium capped as % of notional (scaled by moneyness) + spend-window cap. `max_rounds_per_day`. ~~Premium is paid into a PDA the user claims~~ → premium goes to the user's USDC ATA, created idempotently by the maker (decision log).
- **Maker last look:** `take_round` reads a fresh Pyth price; reject if spot moved more than X% since `open_round`. Keep auctions short (~30 s).
- **Agent desk trimmed to 2 LLM roles:** **Quant** (tool-calling, proposes) + **Risk** (veto that changes an on-chain parameter). Intake = the beginner form (free text cut). The card is rendered by deterministic code. Show tool-call traces next to the memo hash. Pitch as "agent proposes, program enforces."
- **Demo hero moment:** the agent proposes an out-of-bounds round → the program **rejects** it on-chain → shown with the memo hash. That frame answers "why Web3". *(Revised: Risk doesn't see bounds; use a real rejection from the `/desk` feed, not a cued one — §13 step 6.)*
- **Precompute the desk's card in the worker** and have the Next.js route read Supabase (the Quant + Risk calls would time out a serverless route).
- **Memo storage:** Supabase, hash = sha256(JSON). Skip Arweave.

**Hosting — both advisors recommend dropping Cloudflare for the worker:** `@solana/web3.js` 1.x + Anchor in workerd has rough edges (Buffer/crypto, 3 MB script cap), and hosting isn't judged. Recommended: one always-on Node process, demo laptop as fallback. *(Resolved 2026-10-05: the user's own ECS VM — §9b.)*

**Scope reality:** both advisors call the full spec ~3× too big for 36 h. *(User decision 2026-10-05: full scope anyway.)* Build order unchanged: **SOL put loop first** (Lend CPI → auction → sampled settle → escrow swap → agent rejects/accepts on-chain), recorded by H26, then the rest.

**Final stress test (2026-10-05, Fable 5.1) — applied:** demo premium/strike fix (§12, §13), `unwind_round` liveness + pool exposure release (§9), hosting resolved (§9b), desk docs aligned to 2 roles (§4, §6b, §11), real-not-staged rejection (§11, §13), LLM decision space (§11), randomised makers (§10), Pyth rent (BUILD §4.3), premium destination (above), Lend plan B (BUILD §3.6). Estimated score if the loop ships on video: ~71/100 — see §22 for the plan to push it higher.

## 22. Score plan — what 90+ would take (honest)

The 71 estimate is one model's guess, not a measurement. Judging is relative to the other teams (~200 builders). 90+ is reachable on paper but not something to count on; the levers below are what we control.

| Weight | Est. now | Ceiling | What moves it |
|---|---|---|---|
| **Functionality 30** | 22 | 28 | **Working live URL** (we demo it; no judge test funds). Worker runs continuously from ~H20 so `/plan` and `/desk` show **hours of real rounds**, not one take. Put + call + wheel all work. Unwind proves no stuck funds. |
| **Technical 25** | 19 | 23 | Real Lend CPI (not plan B), real Pyth bucketed settlement, agent with real decisions (§11), Clef probabilities in the memo, Anchor test suite with negative tests shown in the README (count + CI badge). Architecture diagram in the deck. |
| **Innovation 20** | 13 | 16–17 | Hardest to move: on-chain dual investment exists (Ribbon/Friktion/Katana/Leaps). Push the genuinely new parts: (1) **verifiable agent** — every decision hashed on-chain and every rejection public; (2) **CEX-anchored on-chain floor** that protects a beginner from a bad auction; (3) **premium + Lend yield stacked** on one collateral; (4) **composable "paid limit order" primitive** — another app can open a plan via CPI (show one CPI test); (5) **goal-based plans** ("buy 10 SOL at $110 by Dec", managed round after round) — Leaps/Binance DI sell single options; (6) **shareable Blink** — a paid limit order you can post on X. Don't claim novelty for the options product itself, and don't headline premium + Lend stacking (Lend is ~10× smaller than premium; earlier vaults parked collateral in lending too). |
| **Impact 15** | 10 | 13–14 | **Evidence collected at TOKEN2049 itself** (biggest cheap lever): 15–20 short interviews, a waitlist count, 1–2 maker conversations, quoted in the deck. Plus the Binance DI / Rysk / Jupiter numbers already in §2. |
| **Demo 10** | 7 | 9 | ≤ 3 min, one story (one user, one goal), a real rejection on screen, clear "you got $X" moment, numbers never absurd. Rehearse the pitch 3×. |
| **Total** | ~71 | ~89–91 | Every row at its ceiling, which needs the full loop solid by H26 and the evidence collected during the event. |

**What would drop it hard:** the loop not closing end to end on video (functionality → ~10), the live URL dead when judges click, or a "did you stage that?" moment with no honest answer.

**Startup notes:**
- ~~Real makers won't quote per-user 60-s auctions → batch into daily auctions~~ → done: epochs (decision log).
- Full-notional maker escrow is capital-inefficient → later: partial maker margin + forfeit-on-default.
- On-chain Dual Investment clones (Ribbon, Friktion, Katana) lost TVL after incentives and drawdown assignments. Distribution is the moat → Jupiter-adjacent plug-in; validate with 15–20 interviews at TOKEN2049.
- Beginners will still feel cheated after a crash assignment → mandatory two-scenario confirmation screen.
