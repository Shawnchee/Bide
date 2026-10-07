# Bide devnet wallets

Devnet only. Never send mainnet funds to these. Secret keys live in `keys/` (gitignored).
USDC below = **Circle devnet USDC** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (the only one Jupiter Lend devnet accepts).

## Balances and roles (checked on devnet 2026-10-06 11:31 UTC)

| Role | Public key | What it does | SOL | USDC | WSOL |
|---|---|---|---|---|---|
| demo-user (Phantom, user-owned) | `6f7znmBfioj11fMmRTEnSC8xGgv2WTeHN9UpXo8fD3FY` | the user in the recording; **also receives the 10% platform fee on devnet** | 10.78 | 52.01 | — |
| deployer (upgrade authority, Config admin, **pool authority + only LP**) | `HEf2YSqzg1nUk9gztyboYNtWiQyRJGkWfu24mSCChu1r` | deployed/upgraded the program (programdata rent 5.08 SOL); created the integration plans; deposited 25 USDC + 0.5 WSOL into the pool | 5.14 | 13.13 | 0.15 |
| keeper (agent key = `Config.agent`) | `CXeiLyivTuHns3tyhusJiLMudtzgbbxyAaNLGZjGuBPh` | opens epochs and rounds (desk proposals as-is), posts Pyth samples, resolves, withdraws, unwinds, expires, pool takes/cancels. `open_epoch` rent (~0.00144 SOL) is not reclaimed; sample rent is | 4.38 | 0 | — |
| maker-1 ("Event desk" AI maker) | `FBrENVRrpAF6XR3nuxD5psm6Xompgs61iFJtPjGNpB24` | pays premiums, escrows WSOL (puts) / USDC (calls); worker tops WSOL up to 1 SOL at start | 3.00 | 36.98 | 1.05 |
| maker-2 ("Momentum desk" AI maker) | `9aa4zR5HnKfDm3vV5UeiuMpoS7vZLtZbj8u77kgebk69` | same | 2.89 | 52.42 | 1.00 |
| maker-3 (optional, **unused**) | `7vd5TCbUXzM1HmcDGwec6Vwgog9ipShxL6AkL2S8VRtP` | spare bot; not funded, not in the worker env | 0 | 0 | — |
| demo-owner (key in `keys/demo-owner.json`) | `D1cMzVCaM5VWqCnUAbDyao4RdaQXiXgw2VjpxRSKGXhQ` | created 2026-10-06 for the optional **demo-plan keeper** (keeps one quick buy + one quick sell plan alive). **Not enabled** — the key is not in the VM env; pending the user's decision. Funded by the deployer ([3EX61RnG…](https://explorer.solana.com/tx/3EX61RnG12zGHV1YQ9DYru4a4HzQZCJHPpWncUDe9XnjQMKrqSgxUzKy9H6TqvQofjJPUxp3RyKgZoNuDY57H75i?cluster=devnet)) | 1.50 | 15.00 | — |
| **Backstop pool** (PDA, not a wallet) | `3vY4n9WmQg7PR1W4HJb3zvKRHFevCDgGavdz7FE6u7Q6` | buys untaken rounds at the floor. Initialised 2026-10-06 09:57 UTC by the deployer. Caps: premium ≤ 150 bps of notional, open notional ≤ 40 USDC, utilisation ≤ 50%, spend ≤ 2 USDC per 24 h. No `pool_take_round` yet | — | 25 (vault, at deposit) | 0.5 (vault, at deposit) |

USDC = Circle devnet USDC. Plan collateral sits in plan vaults as jlUSDC / jlWSOL (not in these wallets). Pool vault figures are the deposit amounts from `notes/data-flow-fixes.md`, not re-read.

~~Funding plan (2026-10-05): demo-user 60, deployer 100, makers 40 + 40 USDC~~ — superseded; balances above are what we actually have. Top up a maker from the Circle faucet if its USDC drops below ~15 (sell-round escrow is K × Q).

**Fee wallet:** devnet fees go to demo-user (no separate wallet; devnet fees have no value). Before mainnet, point `Config.fee_recipient` at a dedicated wallet with `set_fee`.

## Who can fund the pool?
**Anyone.** `pool_deposit` is permissionless (on-chain; the `/pool` page's deposit button is not wired yet, so today it is `scripts/init-pool.ts` or a hand-built tx): deposit USDC/SOL, get pool shares, withdraw your share of the unreserved funds any time. Depositors get pool shares whose value moves with the pool's results (Lend interest on idle USDC + winning rounds − premiums paid); no fee share. On devnet the deployer made the first (and so far only) deposit: 25 USDC + 0.5 WSOL.

## Funding
- USDC: faucet.circle.com (rate-limited per address). SOL: faucet.solana.com (`solana airdrop` no longer works).
- Check: `solana balance <addr> --url devnet` and `spl-token balance 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <addr> --url devnet`, or `scripts/integration/state.ts`.

## Pre-H0 accounts checklist (accounts, not code)
- [x] Helius devnet RPC key
- [x] Supabase project (3 migrations applied; worker `/health` reports `repo: supabase`)
- [ ] Vercel project — app **not deployed yet**
- [x] Cloudflare Workers AI token (scoped to Workers AI only); Clef answering live
- [x] ECS VM set up: pm2 (user `bide`, systemd `pm2-bide`), env file `/etc/bide/worker.env` (chmod 600). Caddy **not** in use: 80/443 are taken by another service, so the worker has no public HTTPS route yet
