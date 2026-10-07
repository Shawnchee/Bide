# Bide — technical pitch script (reference / Q&A source; the stage slot is a ≤ 3 min video only — see DEMO-SCRIPT.md)

## 0. One line (10 s)
"Bide turns a limit order into income: name the price you want to buy or sell SOL at, and get paid up front every round while you wait — with your money earning Jupiter Lend interest. An AI desk runs it; a Solana program enforces your limits."

## 1. Problem (20 s)
"A limit order earns nothing while it waits — you hand the market a free option on your price. Option yield fixes that, but it needs options knowledge and manual re-opening every week. Binance Dual Investment has ~500K users doing this on a CEX; nothing on Solana runs a price goal for a beginner."

## 2. What Bide does (20 s)
"You say 'buy SOL at 110 by November'. Under the hood that's a cash-secured put, sold round after round. Every round a market maker pays you a premium up front. If SOL settles below your price you buy at exactly 110; if not, you keep your USDC. Either way you keep the premium, and the USDC sits in Jupiter Lend earning interest."

## 3. The AI roles — who does what and why (60 s)
| Role | Model / code | Decides | Why this choice |
|---|---|---|---|
| **Intake** | GLM 5.3 (Z.ai) | Turns plain English into plan fields; % moves become a price **in code** from live Pyth | Natural language is where an LLM beats a form; the model never does arithmetic |
| **Quant (desk)** | GLM 5.3 with 9 tools | Each round: open / skip / flip / stop, which expiry, how much of the goal this round (ladder), auction start and floor | Needs tool calling and multi-step reasoning across market data, calendar and past outcomes |
| **Risk** | Cloudflare **Clef** (decision model) | Scores the proposal: approve / adjust / veto, event risk, data quality, user fit, rationale consistent | Returns calibrated **probabilities**, not prose — the right tool for a veto gate; never sees the user's limits |
| **Makers ×2** | GLM 5.3 personas | Bid or pass + discount below fair + written thesis; code computes the bid | Two opposite views make the auction a real competition; theses are hashed and auditable |
| **Program** | Solana (Anchor) | Enforces every limit, holds the money, settles | Code, not AI: the neutral referee none of the agents can override |

Say: "The agent is allowed to try; the program decides. Every decision is hashed on-chain, and when the AI proposes something outside the rules, the chain rejects it in public."

## 4. How we price (20 s)
"There's no options order book on Solana, so the auction creates one. For each round we pull live option quotes from Deribit, OKX, Bybit and Binance, read each venue's implied volatility at our exact strike and expiry, take the median across at least two venues, and run Black-Scholes with the Pyth spot price. That gives fair value; the auction starts at fair × 1.3 and can't go below the median exchange bid × 0.9."

## 5. Settlement (20 s)
"At expiry we don't trust one price. The last 30 minutes before 08:00 UTC are cut into ten 3-minute slots; for each slot, the program only accepts the first Pyth update at or after the slot starts, verified through Wormhole on-chain. The median settles every round in that epoch. If too few samples land, anyone can unwind — no funds get stuck."

## 6. Why Solana (15 s)
"Thirty-second auctions and ten verified oracle samples per epoch only cost cents here. One program composes Jupiter Lend, Pyth and Wormhole — and any app can open a plan by CPI or a Blink."

## 7. Business + honesty (15 s)
"Bide takes 10% of each premium, on-chain; it's never the counterparty. It's devnet and unaudited; the two AI makers are our demo liquidity — anyone can be a maker. Next: real market makers with perp hedging, an audit, and licensing."

## 8. Close (5 s)
"Name your price. Get paid until it fills."

---

## Q&A crib (one line each)
- **Fair vs bid premium?** Fair = price at the venues' median mid volatility (what it's worth); bid = price at their median bid volatility (what a pro would pay now). Both are per SOL, times the round's size.
- **Why 1.3 and 0.9?** Judgment parameters: 1.3 leaves room for an eager maker to pay more; 0.9 under the real bid stops a beginner being filled far below market. The program also caps start ≤ 3 × floor.
- **Don't your makers just lose money?** An option buyer loses most rounds and wins on big moves; ours buy below fair, so they shouldn't lose on average. They're demo liquidity; real makers hedge.
- **Can someone farm the bots?** Bots never pay above fair and only buy from plans the program checked; the only edge would be knowing the settlement price early, which the bucket rule blocks. On devnet it's test money anyway.
- **Will you hedge so the maker never loses?** Don't promise "never". Say: "v2 delta-hedges with perps, which removes the directional risk; the maker's profit becomes the discount to fair value."
- **Did you prompt the AI to break the rules?** No — the prompt doesn't forbid it and Risk never sees the limits; every rejection is from the running system.
- **What if the keeper dies?** Unwind and expire are permissionless; samples can be posted late by anyone.
