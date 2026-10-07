# deeznuts — TOKEN2049 Origins Hackathon project

Read `HACKATHON.md` before any significant design or scope decision. Every feature must earn its place against the judging weights there (30% functionality, 25% technical integration, 20% innovation, 15% impact, 10% demo).

- Targets: Main track + Solana "Best Use of Solana" (needs a Solana program at the core).
- No substantial code before the official hackathon start (4 oct 2026) — eligibility rule.
- Prefer depth in one solution over many features.
- `SPEC.md` holds the product spec, open questions and decision log. Update its decision log when a decision changes.
- `HANDOFF.md` is the kickoff brief for a fresh build agent — start there at H0.
- `BUILD.md` is the phase-by-phase build plan (accounts, instructions, worker, agents, frontend, timeline). Follow it during the hackathon.

## Secrets (strict)
- Wallet keypairs live only in `keys/` (gitignored, chmod 600). Public keys are in `WALLETS.md`.
- Never print, log, copy, or commit a secret key, `.env`, or `.dev.vars`. Never hardcode keys or the Z.ai / RPC keys in code.
- Hosted secrets go in `wrangler secret put` (Cloudflare) / Vercel env vars, not files.
- Before every commit: confirm `git status` / `git diff --cached` shows no `keys/`, `.env*`, `.dev.vars`, and no key material in staged files (no gitleaks — user decision 2026-10-05).
