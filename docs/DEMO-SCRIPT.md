# Bide — demo video script (≤ 3:00)

Format (HACKATHON.md): the **whole pitch is one screen recording, ≤ 3 minutes** (organiser slot), **embedded in the .ppt/.key deck** (no live demo on stage, no YouTube link). One story, real devnet transactions. ~380 words of voice-over at a calm pace; aim for 2:50. Cuts are fine (label waits as "10 minutes later"); never fake a screen.

The video carries everything — problem, demo, why Solana, competitor point, business line — so the deck is only 3 slides: (1) title, (2) the video full-bleed, (3) proof/end card (program ID + cluster devnet, 3 explorer tx links, repo link, "Pre-existing work: none", "Devnet, unaudited").

**Before recording:** worker healthy on the VM; Phantom on **Devnet** as demo-user; one quick buy plan already created ~15 min earlier so a full cycle exists to cut to; `/desk` showing the real on-chain rejection; explorer tabs open for the tx links. Record at 1440×900, dark theme, browser zoom 110%.

| # | Time | Screen | Voice-over |
|---|---|---|---|
| 1 | 0:00–0:15 | Landing page, hero "Name your price. Get paid until it fills." | "A limit order earns nothing while it waits. You've given the market a free option on your price. Bide pays you up front to wait, and your money earns Jupiter Lend interest the whole time." |
| 2 | 0:15–0:35 | `/earn` → type *"I want to buy about 20 USDC of SOL if it dips around 2% this week, I'm patient"* → **Fill the form for me** → form fills: Buy, SOL, $117.70, 20 USDC (cut the wait) | "I just say what I want. An AI agent turns it into a plan. The price, two percent below the live Pyth price, is computed in code, not by the model." |
| 3 | 0:35–0:55 | **Preview** → desk steps stream: calendar, Pyth, Deribit/OKX/Bybit/Binance quotes → "Risk (Clef) 62% approve" → card: *first round 0.056 of 0.1699 SOL… $0.02–$0.04 upfront*, memo hash | "The desk prices the round from real options quotes on four exchanges. GLM proposes, Cloudflare's Clef judges risk, and the reasoning is hashed on-chain." |
| 4 | 0:55–1:10 | Review: both outcomes + "checked once at expiry, not on touch" + crash case → **Start earning** → Phantom → one signature → explorer: USDC → jlUSDC | "Both outcomes in plain words, then one signature. My USDC goes into Jupiter Lend." |
| 5 | 1:10–1:35 | `/auctions` (or `/plan`): two AI makers' bids with opposite theses ("quiet window…" vs "momentum favours protection…"), one wins, premium lands; maker P&L ledger | "Two AI market makers with opposite views bid in a Dutch auction. The Solana program escrows their side and pays me the premium up front." |
| 6 | 1:35–2:00 | *"10 minutes later"* → `/plan`: 10 Pyth samples filling the buckets → settled at the median → swap at exactly the strike (or not filled, premium kept) + explorer link | "At expiry, ten Wormhole-verified Pyth prices settle the round on their median. I either buy at exactly my price or keep my USDC. I keep the premium either way." |
| 7 | 2:00–2:20 | `/desk` → the real on-chain rejection row (`AuctionParamsInvalid`: the agent proposed a 300 s auction, the program's quick limit is 120 s) → explorer showing the failed tx | "The agent is allowed to try; the program decides. Here it proposed an auction outside the rules, and the chain rejected it in public." |
| 8 | 2:20–2:35 | **Text card:** 4-column table (Jupiter Trigger · Earn on Recurring · Leaps · Bide), "AI with on-chain guardrails" row highlighted; Leaps labelled "mainnet, audited" | "Leaps sells you one option and leaves you to manage it. Bide runs the whole goal, earns Lend yield on the collateral, and lets anyone be the maker. Thirty-second auctions and ten verified oracle samples only cost cents on Solana." |
| 9 | 2:35–2:50 | **Text card:** "10% of each premium, on-chain · never the counterparty · devnet, unaudited · next: real makers, audit, mainnet" | "Bide takes 10% of each premium, on-chain, and is never the counterparty. This is devnet and unaudited, and the two AI makers are our demo liquidity. Next: real makers, an audit, mainnet." |
| 10 | 2:50–3:00 | End card: program ID + "devnet, open source" (or a real daily round settled at **08:00 UTC**, std sell `8kaDR2Sn…`, as a b-roll cut-in earlier) | "Name your price. Get paid until it fills." |

## Rules for the cut
- Use only real transactions; every explorer link must match what's on screen.
- Say "devnet". Don't say "same as a limit order" (say "same price as a limit order, different trigger").
- Quick plans are labelled "quick-plan pricing" on screen — leave the label visible.
- Don't claim the AI broke a *user's price bound* — the real rejection so far is the auction-length rule.
- No revenue projections; the business card is the fee and the honesty line only.
- Keep Leaps labelled "mainnet, audited" on the comparison card — don't imply it's weaker as a product.
- If the 08:00 UTC (16:00 SGT) settlement isn't recorded in time, use the quick-plan cycle for scene 6; submission is 23:59 SGT.

## Backup cuts
- Desk preview slow → cut from "Preview" to the finished card.
- No maker takes during recording → show the pool backstop take (`/auctions` row "pool") or a recent real round from `/auctions`.
- Running long → shorten scene 3 first, then scene 8 (drop the Solana sentence last, it's the Solana-track criterion).
