# TOKEN2049 Origins Hackathon — Rules, Tracks & Judging

> Source of truth for what we're building against. Re-read before every major decision.
> Event: TOKEN2049 · Singapore · 6–8 October 2026 · 36h build sprint · 200 builders · $150K prizes/credits.

## Our target tracks

1. **Main track** (mandatory — everyone submits here; Top 5 demo on the TOKEN2049 stage, share $100K AWS credits)
2. **Solana — Best Use of Solana** ($10K: 1st $5K · 2nd $3K · 3rd $2K)
   - Requirement: **the project must include a program that interacts with Solana.**
   - Any category is fine: DeFi, payments, consumer, AI-powered products, etc.

## Solana track — official guide (docs/Solana_Hackathon_Guide.pdf, read 2026-10-06)

**Qualification checklist (all required):**
- [x] Interacts with Solana via a program we deploy (+ meaningful CPI into Jupiter Lend and Pyth). A read-only frontend would not qualify.
- [x] Functional on Devnet — README must state **Program ID `4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe` + cluster devnet**.
- [x] At least one example transaction link (Solana Explorer / Solscan) — README evidence section.
- [x] Code written during the hackathon; **any pre-existing work disclosed in the README** (✅ 2026-10-06: README line "Pre-existing work: none" — planning docs only before kickoff 4 Oct).
- [ ] Public GitHub repo or judge access (local commits exist; **push / repo visibility needs the user's go-ahead**).
- [ ] **A working demo a judge can run end to end without assistance** → judges need devnet SOL (faucet.solana.com) + Circle devnet USDC. Done: README 5-step "Try it yourself"; worker unattended on the ECS VM (pm2, Supabase). **Still open (2026-10-06 11:30 UTC):** app not on Vercel (no live URL), no public HTTPS route to the VM worker (preview/intake/quotes), browser-wallet `create_plan` not yet recorded, and no active quick plan (all Filled) unless a judge creates one.

**Solana track judging (differs from Main track):**
| Weight | Criterion | What judges look for |
|---|---|---|
| 30% | Technical Execution on Solana | Core logic on-chain scores higher than projects that merely touch the chain |
| 20% | Innovation & Originality | New idea or clearly better take on an existing one |
| 20% | Product & UX | Works and is pleasant, incl. onboarding and wallet flow |
| 15% | Real-World Impact & Viability | Who needs it; plausible path to users |
| 15% | Demo & Presentation | "A live demo counts for more than slides" (the Main-track stage still requires a recording) |

**What they want:** projects that are only possible on Solana, or make its strengths obvious (sub-second finality, low fees, throughput, composability with existing programs). Our answer: 10 Full-verified Pyth samples per epoch and 30-second auctions are only affordable/fast enough on Solana; composability with Jupiter Lend (CPI) + Pyth receiver + Wormhole in one program.

**New on Solana (mention, don't depend on):** Alpenglow live on devnet since 1 Oct (≈54 ms median finality on testnet) — our auctions and settlement get faster for free. V1 transactions (4,096-byte limit) would let us post a Pyth VAA + `post_sample` in one tx instead of two, but need web3.js v3 / Kit — roadmap, not this build.

**Ops notes:** `solana airdrop` no longer works — devnet SOL only from faucet.solana.com (connect GitHub for more) or ask in the Token2049 hackathon Telegram. On-site Solana judge/mentor: Andre Correia (Head of DevRel); mentors Chaerin Kim, Mike Ma.

## Main track judging (weights)

| Weight | Dimension | What judges ask |
|---|---|---|
| **30%** | Functionality & Execution | Does it work as intended? How complete is the prototype? Can the team demonstrate key user journeys, transactions, agent actions, onchain/offchain flows **end-to-end**? |
| **25%** | Technical Implementation & Integration | How well is it implemented? Does it **meaningfully** use the blockchain, smart contracts, protocols, APIs, infra, partner tech? How well are agents, payments, data, tools and onchain/offchain components integrated and orchestrated? |
| **20%** | Innovation & Originality | New idea, technical approach, or creative application of existing tech? Does Web3 **meaningfully** contribute to the solution? |
| **15%** | Usefulness & Potential Impact | Meaningful problem or useful new capability? Who benefits? Potential beyond the hackathon? |
| **10%** | Demo & Presentation | How clearly and convincingly does the team demo the working product and explain what they built, how it works, and why the approach matters? |

Partner tracks may add their own criteria — check the Solana track page.

## Themes (direction, not limits)

AI x Crypto · Stablecoins / Payments · Infrastructure · DeFi · Consumer Apps · Tokenization

## Eligibility rules


## What every team submits

- **GitHub repo** — public, or with judge access granted.
- **Project link** — live URL or hosted demo.
- **Presentation slides** — Google Drive link to a **.ppt or .keynote** file.
- **Deadline:** submit by **11:59pm on 7 October** (cutoff 12:00am 8 Oct). No late entries.
- Partner tracks may ask for extras (demo video, short write-up) — check the track page.

## Stage rules (Top 5)

- Slides: **.ppt or .keynote only** (no Google Slides / Gamma / Vercel links).
- **No live demos.** Use a screen recording **embedded in the slides** (no YouTube/external links).
- Keep slides visual and punchy — they're an aid for the live pitch.
- **Locked at submission** — no changes after the deadline.

## Other partner tracks (not targeted, for reference)

- **Cardano — Agentic Commerce** ($27.5K): x402 agent payments or Masumi (escrow, refunds, disputes, identity, discovery).
- **Chainlink — Best workflow with CRE** ($10K, top 5 × $2K): Chainlink Runtime Environment workflows; Confidential Workflows available.
- **NOWNodes — Multichain Infrastructure** (€6.5K credits): build on NOWNodes RPC/WebSocket/explorer infra across 100+ networks.

## Checklist against judging (fill in as we build)

- [ ] End-to-end flow demonstrable in a screen recording (30%) — every path proven on devnet with tx links (README §5); recording not made yet
- [x] Solana program is core, not decorative; partner integrations are real (25%) — 28-ix program enforces bounds, escrow, settlement; real Jupiter Lend CPI + Pyth Full-verified samples on devnet
- [x] Clear answer to "why does this need Web3?" (20%) — the program, not the AI, decides; public failed txs + on-chain memo hash (README §2). Caveat: no on-chain rejection of a *user bound* yet (only auction-param + timing ones)
- [ ] Named user + problem + path beyond hackathon (15%)
- [ ] Recorded demo embedded in .ppt/.key, deck locked before deadline (10%)
