# HANDOFF — kickstart the Bide build (paste into a fresh agent at kickoff)

> You are the build agent for **Bide**, a TOKEN2049 Origins Hackathon project (36 h, starts **4 Oct 2026**, submit by **11:59 pm SGT 7 Oct**). Planning is finished. Your job: **build the whole thing, phase by phase, exactly as specified, and keep going until BUILD §10 is done** — don't stop after one phase to ask; stop only for real blockers (missing key, failed VERIFY with no written fallback, a decision only the user can make). ~~**Do not commit or push yet**~~ (local commits now exist; still **no `git push`** without the user's go-ahead). Written 2026-10-05.

## Status at 2026-10-06 ~11:30 UTC (read this first if you are resuming, not starting)
Most of this brief is done. Current truth: `README.md` (§5 evidence, §9 limits), SPEC §18 decision log, BUILD §3.3 status + §8 phase ticks, `notes/integration.md`, `notes/data-flow-fixes.md`.
- ✅ Program: 28 ixs on devnet `4bwT…` with the Fable fixes; 28/28 LiteSVM tests. Proven on devnet: buy + sell, exercised and not, `withdraw_collateral`, `expire_plan`, `unwind_round`, `cancel_round`, AI-desk-opened rounds. Pool initialised (25 USDC + 0.5 WSOL); no `pool_take_round`, `flip_plan`, `update_plan` on devnet yet.
- ✅ Worker on the ECS VM (pm2, user `bide`, Supabase store, 189/189 tests): keeper, sampler, mirror, 2 AI maker agents, desk (GLM 5.3 via Z.ai Coding Plan + Clef), intake, LLM queue, public-route limits. Telegram removed.
- ✅ App built (all routes, dark-first restyle). ⬜ **Not on Vercel**; ⬜ no public HTTPS route to the worker (80/443 taken on the VM).
- ⚠️ **Std milestone:** the 6 Oct 08:00 window produced one live call round `5Ccfmg…` (settles **7 Oct 08:00 UTC** — no VM restart 07:20–08:40) and one cancelled put. The 7 Oct 08:00 window can only target ≥ 8 Oct expiries. Runbook: `scripts/STD-WINDOW-RUNBOOK.md`.
- ⬜ Open: no active quick plan (all Filled by ~10:20 UTC); demo-plan keeper built but not enabled (user decision); on-chain rejections so far are 1 `AuctionParamsInvalid` + 3 timing ones (no user-bound rejection, no accepted retry); recording, deck, live URL, repo push (user's go-ahead).

## 0. Before you write anything
1. ✅ (kickoff 4 Oct confirmed) **Do not write project code before the official kickoff time.** Ask the user: "Has the hackathon officially started? What time was kickoff (SGT)?" Writing code earlier makes the project ineligible.
2. Read, in this order: `CLAUDE.md` → `HACKATHON.md` → `SPEC.md` (the why) → `BUILD.md` (the what, exactly) → `WALLETS.md`.
3. **`BUILD.md` §3.2–3.3 is the authoritative account and instruction spec.** SPEC §9 only summarises it. If the docs disagree, BUILD wins. Flag the conflict to the user and fix the doc.
4. ✅ (orchestrator + Opus lane agents) Ask the user who owns each lane: **P** (program), **W** (worker), **A** (agent desk), **F** (frontend). If they don't say, **you own all four** — use subagents (worktree isolation) to run lanes in parallel where they don't touch the same files.

## 1. Product in one paragraph
"Name your price, get paid until it fills." A user says "buy SOL at $110 by Nov 5" or "sell SOL at $150". Under the hood these are **physically settled cash-secured puts and covered calls** on **Solana devnet**:
- **Collateral:** sits in **Jupiter Lend** and earns interest.
- **Rounds:** each round joins a shared **epoch** (daily 08:00 UTC; weekly and monthly on Friday 08:00 UTC; quick plans every 10 min).
- **Auction:** a Dutch auction anchored to real CEX options quotes (Deribit, OKX, Bybit, Binance; at least 2 needed). **2 AI maker agents** (GLM stance → code-computed bid, deterministic fallback) or any wallet (`/maker`) pay the user upfront. If nobody bids, a permissionless **LP pool** pays the floor.
- **Settlement:** at expiry, the bucketed median of **Pyth** samples (posted once per epoch) decides whether the escrows swap at exactly the strike. **The user keeps the premium in every outcome.**
- **AI desk:** GLM 5.3 (Quant) proposes; Cloudflare Clef (Risk) judges. **The program enforces the user's bounds**, so rejections are real and public. Memo hash is stored on-chain.
- **Fee:** 10% of the premium (`fee_bps`), sent to the fee wallet (demo-user on devnet).

## 2. Hard rules
- **Devnet only. No mocks.** Localnet tests clone the real devnet programs: Jupiter Lend plus its Liquidity program, the Pyth receiver, and Wormhole with its guardian set.
- **Secrets:** keypairs only in `keys/` (gitignored, chmod 600). Never print, cat, log, copy or commit a secret key, `.env*` or `.dev.vars`. When committing: first check `git status` and `git diff --cached` — no `keys/`, no `.env*`, no key material. The root `.env` (gitignored, chmod 600) already exists: read values only via `process.env`/dotenv in code; to check a key exists, print the variable **name** and SET/EMPTY, never the value. Worker secrets go in the ECS VM env file (chmod 600); app secrets go in Vercel env.
- **Update the docs after every decision:** SPEC, BUILD, WALLETS, and the decision log in SPEC §18. Use a subagent for large edits.
- **Be honest with the user.** Lead with the real assessment. If tests fail, say so and show the output.
- Assets: **SOL** (built and recorded) and **BTC** (tBTC, built only after both SOL loops are solid, never in the recording). No JUP, no Meteora, no judge faucet, no gitleaks. ~~no free-text intake~~ (superseded 2026-10-06: GLM intake drafts the form; the user still reviews and signs).

## 3. State at handoff (2026-10-05) — historical; see the status block at the top
- **Toolchain:** anchor-cli 1.0.2, solana-cli 3.1.10, Rust, Node 25.9, pnpm. The project directory has docs, `research/` (Jupiter Lend IDLs) and a root `.env` — no code, no git repo yet.
- **Wallets** (public keys in `WALLETS.md`): demo-user 10.78 SOL / 32 USDC; deployer 12.5 / 2; keeper 4.5 / 0; maker-1 4.0 / 3; maker-2 4.0 / 3; maker-3 unused.
  - **USDC is short.** The user is still collecting it from Circle's faucet. If still short, priority is demo-user 30, maker-1 30, deployer 50.
- **Verified devnet addresses** (Jupiter Lend accounts + discriminators, Pyth programs + push feeds, Wormhole): **BUILD §3.7**. Lend IDLs in `research/`. Oracle: **Plan A confirmed 2026-10-05** — mainnet `hermes.pyth.network` VAAs verify Full on devnet `rec2…`; use `scripts/pyth/post.ts` (not the JS SDK). Details: BUILD §3.7, `notes/oracle.md`.
- **Hosting:**
  - **Worker:** the user's **ECS VM** in Malaysia (8 GB; pm2). ✅ running; Caddy unused (80/443 taken).
  - **App:** Vercel. ⬜ not deployed yet.
  - **Database:** Supabase. ✅ 3 migrations applied.
- **Keys in root `.env` (SET):** `PYTH_HERMES_API_KEY`, `HELIUS_RPC_URL`. Use `HELIUS_RPC_URL` for devnet RPC everywhere (public `api.devnet.solana.com` as fallback).
- **Coming later from the user:** Supabase (URL + anon + service key), Z.ai key (+ confirm endpoint/model id), Cloudflare account id + Workers AI token, ~~Telegram bot token~~, optional `JUP_API_KEY`. ✅ all received by 2026-10-06. **Don't block on them:**
  - **Supabase missing →** write the schema (BUILD §7) as SQL migration files, put all DB access behind one small repository module, and run against an in-process store until the keys arrive; then switch with no other code changes.
  - **Z.ai / Cloudflare missing →** build the desk end to end with the tool layer, schemas, memo hashing and keeper integration; leave the model call behind the `RiskJudge`/`Quant` adapters and test them once keys land.
  - ~~**Telegram missing →** build the notify module~~ — Telegram removed 2026-10-06 (SPEC decision log).
  - Never ask the user to paste secrets in chat; they add lines to `.env` themselves.
- ECS VM can reach all external APIs ✅ (checked 2026-10-05).

## 3b. Dev tooling to add at H0 (allowed; not project code)
- Jupiter Docs MCP (read-only doc search incl. Lend CPI pages): `claude mcp add --scope user --transport http jupiter https://developers.jup.ag/docs/mcp`
- Reference code for the Lend CPI: marginfi-v2 `programs/marginfi/src/instructions/juplend/` + `programs/juplend-mocks` (see BUILD §3.7).

## 4. Critical path (BUILD §8 has the full phase list)
1. ✅ **H0:** `git init` (no commits), pnpm workspace, `anchor init bide`, Next app, worker skeleton, `.env.example` (names only). Back up `target/deploy/bide-keypair.json` into `keys/` (chmod 600). Add the Jupiter Docs MCP (§3b).
2. ✅ (except Circle faucet rate) **Phase 0 VERIFY** (BUILD §8). Write every answer back into BUILD.md:
   - **Jupiter Lend:** deposit/withdraw-by-amount from a PDA, the Liquidity program accounts, and the exchange-rate account.
   - **Pyth:** devnet push-feed addresses, the Full-verification path with `closeUpdateAccounts`, and the Hermes historical endpoint.
   - **External APIs:**
     - Z.ai base URL, model id and tool-call format.
     - Clef REST.
     - ~~Every external API reachable from the ECS VM~~ ✅ done.
   - ✅ **Pyth Plan A done (2026-10-05):** mainnet Hermes (not hermes-beta — our key gets 403 there) verifies Full through `rec2…` on devnet → bucketed median as specified. Plan B dropped.
   - **Program size:** gives the deploy rent.
3. ✅ **P lane:** Jupiter Lend CPI (with an address lookup table) **first**, against cloned devnet Lend. Then Pyth Full-verified `post_sample` plus the push-feed spot read.
4. ✅ **By H3:** publish a **stub IDL** (accounts + instruction signatures). It unblocks the W, A and F lanes.
5. ✅ **Program core:** epoch instructions, then the put path end to end, then the call branch, `unwind_round`, `pending_settlement`, `update_plan`/`expire_plan`/`flip_plan`, pool and fee. Localnet tests include every negative case in BUILD §8 Phase 1.
6. ✅ **Devnet deploy** with the deployer, then `init_config`, `add_asset` (SOL), `init_pool` and the first pool deposit (pool 6 Oct 09:57 UTC).
7. ✅ **Worker:** pricer (Deribit + Bybit + OKX first), 2 makers, keeper (epochs, samples, resolve, withdraw, unwind, expire, flip) ~~and notify~~ (Telegram removed). **Build the GLM strict-JSON Risk fallback before Clef.**
8. ✅ (Vercel ⬜) **Frontend:** `/earn` → `create_plan` → `/plan/[id]`, then `/desk`, `/maker`, `/pool`, `/auctions`, the Blink, and the landing page.
9. ✅ **Quick buy loop, then quick sell loop**, end to end on devnet (exercised + not, both sides).
10. **⚠️ Hard milestone:** real std rounds must open in the **7 Oct 08:00 UTC (16:00 SGT/MYT)** auction window. ~~It's the only one inside the hackathon.~~ The 6 Oct window was also used: one call round is live and settles 7 Oct 08:00 UTC (status block above). Map it to an H-number at kickoff and make sure the devnet deploy and keeper are live before it.
11. ⬜ **Record v1 by H26** (SOL only; show after-fee numbers on `/plan`). Then Phase 7 extras, then submission at H31–H35:
    - deck (.ppt/.key with the recording embedded)
    - README with honest limits
    - live URL
    - repo access (commit/push only once the user allows it)

## 5. Definition of done
BUILD §10 is the checklist. In short:
- ✅ A buy plan and a sell plan each run end to end on devnet in one signature each (script-signed; browser-wallet create not yet recorded).
- ✅ Real Pyth samples settle the rounds. The swap happens at exactly the strike, or nothing swaps and the premium is kept.
- ~ At least one real on-chain rejection of the AI's proposal is visible in `/desk` (1 `AuctionParamsInvalid` + timing rejections; no user-bound one yet).
- ✅ `unwind_round` is proven.
- ✅ Real std rounds are running (call round `5Ccfmg…`, settles 7 Oct 08:00 UTC).
- Zero mocks.
- ⬜ A recording of 3 minutes or less (the whole pitch) is embedded in the deck, submitted on time.

## 6. Working style
- Report progress in short updates at each phase exit: what works (with tx links / test output), what failed, what's next.
- Run tests and real devnet transactions to prove each step; never claim something works without running it.
- After each decision or VERIFY answer, update BUILD/SPEC (+ decision log) in the same step.
- Keep the 7 Oct 08:00 UTC milestone visible in every update until it's met.

## 7. First message to send the user
"I've read CLAUDE.md, HACKATHON.md, SPEC.md, BUILD.md, WALLETS.md and HANDOFF.md. Pyth and Helius keys are set in `.env`. Before I start: (1) has the hackathon officially started, and what time was kickoff (SGT)? (2) should I own all four lanes, or is anyone else on the team? (3) is the ECS VM ready (pm2, Caddy, env file)? (4) how much devnet USDC does each wallet have now? Then I'll run Phase 0 and keep going through the build without committing."
