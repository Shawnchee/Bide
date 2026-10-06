#!/usr/bin/env bash
# Dump real devnet program ELFs + accounts into tests/fixtures/ for LiteSVM tests. Reproducible; re-run any time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/fixtures"
mkdir -p "$OUT/programs" "$OUT/accounts"
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env" >/dev/null 2>&1; set +a; fi
RPC="${HELIUS_RPC_URL:-https://api.devnet.solana.com}"

PROGRAMS=(
  7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3 # Jupiter Lend (Earn)
  5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL # Lend Liquidity
  68LHLkpgjAvo6Lgd9FT6KYEX4FWn1911EohSXxHYMFjc # Lend rewards rate model
  rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp  # Pyth receiver (upgraded)
  pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou  # Pyth push oracle (upgraded)
  HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL # Wormhole (receiver's)
)
ACCOUNTS=(
  # Lend shared
  DeF2BVMjWdCamK71nqBZ7uzQkLeW9MJ6C7zoCKLJXEmW DFHSbFzMU67yHK9yLsLBLso7aEnzrB4ZQR7KBujmSU3M
  # USDC market
  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU 2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu
  98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa 644Eh222dNe1V6sSRkYHBcdpxfjtxBBptAJ6mZujRRNo
  CpSRFppSpkdPw7juvRpSxwVyZMN3y8g7cHXCbrc3MBUs B5JAZXGKaZfWsUrauprZVNQM7HwXN8AfKVTt25qtDKYV
  CWFPa1gcDqGyeTHTmdbhGjCnQv7eRfdhnBpZKFzNr1R2 dUnUR9XxaVWZo5FUi5DGqsMWfAzYPdtgkuiDbPLLtYX
  GGtryeuwjcWoG6zg4Xi1vUJN1xRhypms4xt129BKTUxt
  # WSOL market
  BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU GAvizzttfkgetRzkZY9fqzCYo3fJULM7E9V1Gq5CVTNS
  BA6Sg5PUACHHUgK9emXGLdLXEVuPvWGZADo5ZqTLqVi1 HNT4VUeaBaBMqqCa1oJWwG8g1TApZfAJR6e34h9JL5c1
  Gi2KLaG18VZYF6TG8qhTbuVjw3pANXuMjYsZkskasXzR GoT7214qjHGt6QNqQKhQmqFFVT3qVwzjZvUZK4enV8E7
  8vVkrDGaQZz2wkVp3ta8WYRMiSQz2WD4ckEpHfmm2oiB CnKAZc6aSnncZRRM9K1bsP1ngS6yAayYYDBQBcQdTwef
  # Pyth / Wormhole
  7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE APgzQGGdv2qCgBkX6aHVkrGePtBVDDg68GiqaM7rmtf5
  59LY6jV5LcoEdXrhNhX7AJQmW1gHUHQWSLy3299CgGBY H3R4M45f2gyqp6geVUruapzZdyxpgGZ96UnWkDM3ndye
)
for p in "${PROGRAMS[@]}"; do
  solana program dump -u "$RPC" "$p" "$OUT/programs/$p.so" >/dev/null && echo "program $p"
done
for a in "${ACCOUNTS[@]}" "$@"; do
  solana account -u "$RPC" "$a" --output json-compact --output-file "$OUT/accounts/$a.json" >/dev/null && echo "account $a"
done
date -u +%s > "$OUT/dumped_at"
