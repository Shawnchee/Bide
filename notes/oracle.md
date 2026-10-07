# Oracle verification (P2) — 2026-10-05, ~15:00–15:20 UTC

## VERDICT: Plan A PASSES — use **mainnet `hermes.pyth.network`** (not hermes-beta)
- Mainnet Hermes updates verify **Full** on devnet through the upgraded receiver `rec2…` (encoded-VAA path), latest **and** historical (15 min, 7 days old). Plan B not needed.
- Why BUILD's worry was wrong: Hermes VAAs today are signed by **guardian set index 1, 3 signatures, emitter chain 26 (Pythnet)**. Devnet wormhole `HDw2…` holds set 1 at `59LY6j…` = 5 keys, never expires; receiver config `H3R4M4…` = wormhole HDw2…, minSigs 3, fee 0, data source chain 26 / Pythnet emitter. Same set → verifies.
- hermes-beta: **our key is not entitled** → `403 Not entitled: feed ef0d… (invalid API key)` (401 without key). Feed list (`/v2/price_feeds`) is public there and uses the same ids. Not needed.
- post_sample accounts: as specced — `PriceUpdateV2` owned by **rec2…**. programs/bide already uses `pyth-solana-receiver-sdk 2.0.0` with `features = ["pro-compatible"]` → `declare_id!(rec2…)`, so `Account<PriceUpdateV2>` owner check is right (without the feature it's rec5… and fails).

## 1. Plan A evidence (payer = keeper CXeiLy…, devnet, genesis EtWTRA…)
| Run | tx A (create+init+write) | tx B (verify+post_update) | close | PriceUpdateV2 |
|---|---|---|---|---|
| latest, pt 1791212207 | 2xejSC7VF8aJy6bJgkHNk1TE5e5mKyBx5bp24kkDDzCdSVm8tZHS8v45Q2uh1wy3eA66dwEaUkwjieh5ebygPHua | 5RdVqoqj7SDTMZjsH5nix443sFmLPucNbnA8mYGvCTLvJkCNNybbRWNVrsUV3pmHTend8gonzk7jq4Dm1CK1q2Qu | 5Ezuas79UowUEeT865V6EJYNcfLDqM4H8wJJQW1vqcWaRaqNnKq8G8vgQxyvwGwDqo3VSA5cFS5Cb7KKp8CCAua7 | EuySmW8T… Full, px 11941856962e-8, conf 1760860 |
| historical −15 min, pt 1791211340 (fixture) | 3Fg5AtGMrzVgctBteuxwFJt3JzLuUyd5DWaoJdPidUJYRSDR1hNEtemsU5nDAn5y5689HJRsDTsKFSyUPU1DViVK (3,038 CU) | 8zfcGGJ3rbnduYCFoypFcRjaChtA2H5jV9RpmA7QyxKsPbTqGL9JbUiaTocnecbwVULj9LSx76S99zokkFgBkcD (101,294 CU) | 2whnjmyBA5f3XbbJcKZ1gMpUuSJ4AG5mP61Y3w3hDUHYuJnPWTqAUMPxfpJsN8395uUGZEgr2yndYVAMoet6zSKY | DP9qgnA6… Full, px 11973502730e-8, conf 1497270 |
| historical −7 d, pt 1790607467, close **in tx B** | 2nM36Ydf5gZykU1SanTDEa2s1yDFHtBwN9Nkjw3RxGyvJtFbuGNYNC1UsQRTV86f9LCTieEZXNhw1jWsjoXRGyPM | 2XBY9ackaXUq8FA6g3CW4QHy31mxgsjJoTgtTKdiZdtU4aAKEhZ5cUcruJXB1yPs9hDhfFMvMLQsZNM23YrJu1GL (post+close same tx) | — | — |
| BTC/USD latest, pt 1791212237 | 2kxwHF1P2VmzAfCQcYp3Bue4VeaVCNGi7fTuuDugPQ8sB5zXwj2DTbGhB6McgRK1mNNKNqbE4h3iRA4ihK9oivSV | 3et7cTDSSsHDYuCudLnn3kXnmRaMYtwjjFQAFD4jmEKzxG7Y9sawjXZB3AwKSXVc45ZAaSZM4p2WXgF7qW8CivuN (101,298 CU) | 4hE84AuQGBKtbSz5zRhCXo8Euvrea5WNZAWwuA7jsf1qBFN51j93e54zgdXZsR6rRGojGk8wF1kxj4kvmB2o6KpS | DSt1JwCR… Full, px 8555001690927e-8 |
Explorer: `https://explorer.solana.com/tx/<sig>?cluster=devnet`. After close, encoded VAA + PriceUpdateV2 accounts are gone (rent back). Total spend for all runs ≈ 0.0001 SOL (fees only).
- PriceUpdateV2: 134 bytes, 1,330,960 lamports rent, owner rec2…, `write_authority` = poster, `verification_level` = Full, `prev_publish_time` = publish_time − 1.
- VAA = 292 bytes → fits one write; **2 txs** needed (whole flow in one tx = 1,311 B > 1,232). tx B with verify + post_update + both close ixs = 889 B → **343 B headroom for `post_sample`** in the same tx (post → post_sample → close, = "closeUpdateAccounts"). tx B ≈ 101k CU (+ post_sample).
- **JS SDK `@pythnetwork/pyth-solana-receiver` 0.16 is unusable here at runtime**: its ESM build imports `@pythnetwork/solana-utils` → `jito-ts` → web3.js 1.77 → fails under Node 25/tsx (`ERR_PACKAGE_PATH_NOT_EXPORTED rpc-websockets/dist/lib/client`; plain node: missing jito-ts dist path). It does support `receiverProgramId/wormholeProgramId/pushOracleProgramId` and exports `PRO_COMPATIBLE_*` ids (defaults are the old rec5/HDwc/pythWS). `scripts/pyth/post.ts` builds the same Anchor ixs by hand (no SDK import) — W lane should reuse it, not the SDK. Only `.../address` subpath import works.

## 2. Hermes historical endpoint (mainnet hermes, with key)
- `GET /v2/updates/price/{t}?ids[]=…&encoding=base64&parsed=true` → 200, **publish_time exactly = t** (180/180 consecutive seconds, window 1791212369–1791212549; also ±1 s probes, −1 h, −2 d, −7 d, −30 d). `prev_publish_time = t − 1` every time → **1 update per second, no gaps**.
- Edges: t = now+30 → `404 Timestamp is too recent or in the future`; now−1 → 200; −180 d / −400 d → `404 Could not find price updates…` (retention < 180 d; irrelevant).
- **Rate limit:** 8 parallel requests → 284/300 got `429 {"error":"too many requests"}`, `retry-after: 52`. Sequential 1 req/s: 200 requests over 268 s, no 429. Latency p50 254 ms / p95 449 ms. Keeper: serialize Hermes calls, ≤1/s, honour Retry-After.
- **Bucket tolerance:** a 2 s window always contains 3 updates (t, t+1, t+2), so it never misses — but it lets the first poster pick 1 of 3 prints. Better rule (unique, gap-tolerant): accept iff **`prev_publish_time < bucket_start ≤ publish_time ≤ bucket_start + tol`** (= "first update at/after bucket start"; both fields are in PriceUpdateV2). With that, tol can stay 2 s (Quick) / 10 s+ (Std) safely.

## 3. Push feeds (devnet, sampled every 30 s for 15 min)
- PDA `[u16 LE 0, feed_id]` under push program: upgraded `pyt2…` → SOL `7AviUf…` / BTC `APgzQG…` **MATCH**; previous `pythWS…` → `7UVimf…` / `4cSM2e…` **MATCH**.
- **Owner = receiver**, not push program (advisor right): upgraded feeds owned by **rec2…**, previous by **rec5…** (PDA derived under the push program, account owned by the receiver; `write_authority` = the feed PDA itself). Verification **Full**.
- **Cadence (15:03–15:19 UTC, 31 reads):** upgraded SOL & BTC (same publish_times, updated together): 17 distinct publish_times, gaps **61–70 s** (one 7 s gap at 15:13:45→15:13:52), i.e. **~1 update/min**, max age seen ≈ 70 s. Previous set (rec5…): gaps 320, 318, 188, 72 s (BUILD's "~5 min" was this set). Upgraded push-feed prices were Full, e.g. SOL 11944850000e-8 @ 1791212591.

## 4. LiteSVM fixtures (`tests/fixtures/pyth/`, gitignored; README there)
- `sol_usd_full_1791211340.json` — PriceUpdateV2 (Full, owner rec2…) from devnet, `solana account --output json` format.
- `push_sol_usd.json`, `push_btc_usd.json` — push feed accounts (owner rec2…).
- `receiver_rec2.so`, `wormhole_HDw2.so`, `guardian_set_1.json` (59LY6j…), `receiver_config.json` (H3R4M4…), `hermes_sol_usd.json` (one raw Hermes update, base64 + publish_time).
- **Full VAA flow inside LiteSVM: FEASIBLE, verified** (`scripts/pyth/litesvm-probe.ts`): load the 2 .so + guardian set + config, `withSigverify(false)`, send the same 2 txs → PriceUpdateV2 Full, 2,888 + 101,148 CU. **Clock-independent**: works with clock = 0, = publish_time + 1 y. Neither wormhole nor receiver checks VAA age (guardian set 1 has no expiry) → staleness/window checks are entirely our program's job. Treasury PDA need not exist (fee 0).
- Simpler for most tests: `setAccount` a PriceUpdateV2 with any owner=rec2… bytes (layout: disc 8 | write_authority 32 | verification_level (1 = Full, 1 byte; Partial = 0 + u8) | feed_id 32 | price i64 | conf u64 | expo i32 | publish_time i64 | prev_publish_time i64 | ema_price i64 | ema_conf u64 | posted_slot u64); patch publish_time to hit buckets.

## 5. Reusable code
- `scripts/pyth/post.ts`: `postFullUpdate(connection, payer, hermesBase64, {consumerIxs?, closeInSameTx?})` → `{priceUpdateAccounts, encodedVaa, signatures, closeInstructions}`; `buildFullUpdate()` (raw ixs, for custom tx packing); `closeUpdate()`; `decodePriceUpdateV2()`; `pushFeedAddress()`; PDA helpers.
- `scripts/pyth/hermes.ts`: raw-fetch Hermes client (`getLatest`, `getAt`) exposing HTTP status.
- Scripts: `verify-pyth.ts` (post/read/fixture/close), `verify-pyth-variants.ts`, `verify-pyth-cadence.ts`, `verify-pyth-pushfeed.ts`, `verify-pyth-guardians.ts`, `verify-pyth-hermes.ts`, `verify-pyth-edges.ts`, `verify-pyth-ratelimit.ts`, `verify-pyth-beta-probe.ts`. Run: `cd scripts && ./node_modules/.bin/tsx <file>` (`pnpm exec` triggers a workspace `pnpm install` that currently fails on ignored build scripts).

## Recommended BUILD changes
1. §3.7 finding 2 → replace with: "mainnet Hermes (`hermes.pyth.network`, key) verifies Full on devnet rec2… (guardian set 1, 3 sigs). Plan A confirmed; Plan B dropped. hermes-beta: key not entitled (403)." Env: `PYTH_HERMES_URL=https://hermes.pyth.network`.
2. §3.3 #9 bucket check → `prev_publish_time < bucket_start ≤ publish_time ≤ bucket_start + tolerance` (unique sample per bucket, no cherry-picking). Keep Quick tolerance 2 s (Hermes has 1 Hz, gap-free), Std tolerance can be small too (e.g. 5 s).
3. §3.3 #9: `post_sample` should also require `owner == rec2…` (via pro-compatible `Account<PriceUpdateV2>`) — the receiver does no age check, so any old VAA is postable; the window check is the only defence.
4. §4.3 keeper step 3: post at `bucket_start + ~2 s` (Hermes returns 404 for "too recent"); tx A then tx B = [verify, post_update, post_sample, close_encoded_vaa, reclaim_rent] (fits, 343 B spare); ≤1 Hermes req/s, honour 429 Retry-After; use `scripts/pyth/post.ts`, not the JS SDK.
5. §3.2 `max_spot_age_secs` devnet **600 → 180** (upgraded feed updates every ~62–70 s; 180 s = 2.5× worst gap, still survives one missed update). §3.7 finding 1 → "upgraded push feeds update ~every 60–70 s (the previous set ~5 min)". Mainnet 30 unchanged. Note `open_round` row 5 says "spot ≤ 30 s" / take_round "≤ 30 s old" — those must read `max_spot_age_secs`, or devnet auctions fail most of the time.
6. §3.6: note the JS SDK runtime breakage + `PRO_COMPATIBLE_*` exports.
