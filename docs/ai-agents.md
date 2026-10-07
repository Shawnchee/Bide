# Bide AI agents v2 — design (2026-10-06)

> **Revised after Fable 5.1 review (2026-10-06):** LLM reflection memory **cut** → deterministic `recent_outcomes` tool the desk must cite. Makers output `{stance bid|pass, spread_pct 0–20, thesis, confidence}` — code computes the bid and clamps to [floor, min(start, fair)]; stance decided once per (asset, epoch) via one serial GLM queue; `MAKER_LLM=1` flag with deterministic fallback shown as `source: fallback`; makers never see the desk memo or plan bounds; per-maker P&L ledger shown (losses included); theses must pass the provenance check. Intake built last, 202-and-poll. Where the text below disagrees, this note wins.


Goal: make AI a larger, *real* part of Bide without letting an LLM touch settlement or the user's
bounds. Principle unchanged: **agents propose and trade; the Solana program referees.**

## Agents

| Agent | Model | Decides | Referee (cannot be bypassed) |
|---|---|---|---|
| Intake | GLM 5.3 (Z.ai) | Free text → draft plan fields (side, asset, target, size, deadline, min yield, patience). User reviews the normal form and signs. | `create_plan` bounds; the user's signature |
| Desk (seller side) | GLM 5.3 Quant + Clef Risk (exists) | Each round: open / skip / flip / stop, expiry, size, auction params | `open_round` bounds |
| Maker agents ×2 (buyer side) | GLM 5.3, distinct personas | Their own bid for each round, with a short written thesis | `take_round` (spot guard, AuctionOver), per-agent inventory cap; bid clamped to [floor, start] in code |
| Reflection (memory) | GLM 5.3 | After each resolved epoch: what happened vs what was proposed → short lessons | none needed — it writes memory only; memory is input to the next desk/maker run |

### Maker agent personas
- **maker-1 "Event desk"**: reads the event calendar and venue dispersion; pays less when a macro event sits inside the round, more when the window is quiet.
- **maker-2 "Momentum desk"**: reads 1h/24h/7d realised moves and the fill probability; pays more for puts when price has been falling (it wants the protection), less after a rally.
Both see the same tool outputs as the desk (price grid, fair/bid, spot, moves, events) plus their own inventory and their **own past results** (won/lost, premium paid vs settlement value).
Decision happens **once at round open** (LLM latency doesn't matter); the existing taker loop then takes when `auction_price(now) ≤ bid`. Output schema: `{bid_usdc_base_units, max_wait_secs?, thesis (≤ 280 chars), confidence 0–1}`; code clamps bid to `[premium_floor, premium_start]`, skips if below floor; a deterministic fallback (today's random spread) runs if the model fails or times out (logged as fallback).
Each bid → canonical JSON → sha256 stored with the round in Supabase (`maker_bids`); shown on `/auctions` and `/plan` ("maker-1 bid $0.52: FOMC inside the round").

### Reflection / adaptive memory ("gets better after each epoch")
After `resolve_epoch` + `resolve_round`, a reflection call gets: the desk memo, the auction path (start, floor, winning price, winner, seconds to fill, untaken?), maker bids + theses, settlement (median vs strike, exercised), premium vs CEX fair at open. It writes ≤ 5 short lessons to `desk_memory` (scoped per plan and per asset), e.g. "auctions filled within 3 s at 95% of start → start can be higher", "untaken at floor twice → widen expiry".
- Next desk run gets a `recent_outcomes` tool (last N rounds for this plan/asset + lessons). Maker agents get their own `my_history`.
- **What adaptation may change:** auction length, premium_start/floor inside the pricer's [floor, start] range, expiry choice, round size (ladder), skip. Strike only if the user unlocked it, and only in the user's favour (on-chain band).
- **What it may never change:** the user's bounds, min yield, deadline (the chain rejects anyway), settlement.
- Honest framing: *adaptive memory*, not ML training. With ~1 day of rounds the evidence is thin; the UI shows the lessons and the data behind them.

### Intake
`POST /intake` (worker, shared secret) → GLM with a strict zod schema → `{fields, assumptions[], questions[]}`. The app's `/earn` gets a text box above the form ("Describe your goal"); the reply pre-fills the form and lists assumptions ("I assumed 1 month"). Nothing is signed without the normal review screen. Unknown/unsafe values → leave the form field empty + a question.

## Storage (new migration `supabase/migrations/20261006090000_agents.sql`)
- `maker_bids(id, round_pubkey, maker, model, bid, thesis, confidence, fallback bool, bid_hash, took bool, tx_sig, created_at)` — anon select.
- `desk_memory(id, scope text ('plan:<pk>' | 'asset:<pk>'), lessons jsonb, source_epoch, created_at)` — anon select.
- `intake_runs(id, text, fields jsonb, assumptions jsonb, created_at)` — no anon select (user text).

## Demo story (≤ 3 min)
User types a goal → intake fills the form → desk proposes, Clef scores → two AI makers bid with opposite theses → the program picks the winner and escrows → Pyth settles → reflection writes a lesson → next round's desk run cites it. Plus one real on-chain rejection.

## Out of scope
LLM inside settlement; agents with keys beyond their own wallet; pool risk agent; changing the program.
