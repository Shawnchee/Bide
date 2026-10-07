# Deploying bide-worker to the ECS VM (Malaysia, 8 GB)

One Node process (pricer, makers + AI maker stances, keeper + AI desk, sampler, mirror, intake, HTTP) under pm2.

**As deployed (2026-10-06):** code rsynced to `/opt/bide` (no git checkout on the VM), runs as user `bide` under pm2 (systemd unit `pm2-bide`, `pm2 save` done), env in `/etc/bide/worker.env`, Supabase store (`/health` → `repo: supabase`). The worker binds `127.0.0.1:8787`. **Caddy is not in use:** ports 80/443 on the VM are taken by another service (docker), so there is no public HTTPS route to the worker yet; a deployed app's `/api/desk/preview`, `/api/intake`, `/api/quotes` cannot reach it until one exists (another port/hostname or a tunnel).
**Freeze:** no worker restart 7 Oct 07:20–08:40 UTC (live std round sampling 07:30–08:00, resolve after 08:00). Never restart inside a quick window with a Live round.
**Never** paste secrets into chat, git, or this file. They go only into `/etc/bide/worker.env` (chmod 600).

## 1. One-time VM setup
```bash
# Node 22+ (25 used locally), pnpm, pm2, Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm i -g pnpm pm2
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https caddy   # see caddyserver.com/docs/install
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable   # 8787 stays closed
sudo mkdir -p /etc/bide /var/log/bide && sudo chown "$USER" /var/log/bide
```
SSH: key-only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).

## 2. Code
```bash
git clone <repo> ~/bide && cd ~/bide          # or rsync the working tree (exclude keys/, .env*, node_modules/)
pnpm install --frozen-lockfile
pnpm --filter @bide/worker test                # must pass on the VM too
```
The worker reads the IDL from `packages/shared/src/idl/bide.json` — make sure it is present in the checkout.

## 3. Env file (`/etc/bide/worker.env`, chmod 600, owned by the pm2 user)
Create it with an editor on the VM (`sudo install -m 600 -o "$USER" /dev/null /etc/bide/worker.env && nano /etc/bide/worker.env`).
Names (values from the owner; see BUILD §2):
```
HELIUS_RPC_URL=
PROGRAM_ID=
USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
PYTH_HERMES_API_KEY=
KEEPER_KEYPAIR=          # JSON byte array of keys/keeper.json (one line). Never a path on the VM.
MAKER1_KEYPAIR=
MAKER2_KEYPAIR=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
WORKER_SHARED_SECRET=    # same value as the Vercel env var
JUP_API_KEY=             # optional
ZAI_API_KEY=
ZAI_BASE_URL=            # our key is a Coding Plan key: https://api.z.ai/api/coding/paas/v4
ZAI_MODEL_MAIN=glm-5.3
CF_ACCOUNT_ID=
CF_AI_TOKEN=
RISK_BACKEND=workers-ai
QUICK_PLANS_ENABLED=1
# optional
MAKER_LLM=1                 # 0 = deterministic maker bots only
MAKER_STANCE_LEAD_SECS=240
MAKER_LLM_MAX_PER_HOUR=30
INTAKE_ENABLED=1
INTAKE_MAX_PER_MINUTE=6
# DEMO_OWNER_KEYPAIR=       # opt-in demo-plan loop; NOT set on our VM (pending the owner's decision)
```
To move a keypair onto the VM without printing it: `scp keys/keeper.json vm:/tmp/k.json`, then on the VM
`printf 'KEEPER_KEYPAIR=%s\n' "$(tr -d ' \n' < /tmp/k.json)" >> /etc/bide/worker.env && shred -u /tmp/k.json`.
Check names only: `sed 's/=.*//' /etc/bide/worker.env` and `awk -F= '{print $1, ($2==""?"EMPTY":"SET")}' /etc/bide/worker.env`.

## 4. Start
```bash
cd ~/bide/worker
pm2 start ecosystem.config.cjs          # the config parses /etc/bide/worker.env itself (pm2 7 ignores env_file); BIDE_ENV_FILE overrides the path
pm2 save && pm2 startup                 # restart on reboot (run the printed sudo command)
pm2 logs bide-worker --lines 50         # JSON lines; no secrets are logged (env shows SET/EMPTY only)
```
Caddy (only where 80/443 are free): copy `Caddyfile.example` to `/etc/caddy/Caddyfile`, set the hostname, `sudo systemctl reload caddy`.
pm2 restart policy: `max_restarts` 1,000,000 with exponential backoff (a crash loop never becomes a permanent stop).

## 5. Verify
```bash
curl -s localhost:8787/health | jq '{ok, chain, repo, desk, agents, env, loops: [.loops[] | {name, runs, errors, lastError}]}'   # on the VM
curl -s 'localhost:8787/quotes/SOL?kind=put' | jq '.quote | {ok, fairIv, fairPremium, floor, start, venues: [.venues[].venue]}'
```
- `chain` should be `live` (else it says what's missing: PROGRAM_ID, IDL, or Config not initialised).
- `repo` should be `supabase` once SUPABASE_* are set **and all three migrations are applied** (missing tables → in-memory fallback, logged).
- `agents` should show `makerLlm: true, intake: true` and `llmQueue` stats.
- Add an external uptime monitor on `/health` (it returns 503 if any loop has ≥ 5 consecutive errors). **Not set up yet** (needs a public route).

## 6. Supabase
Apply `supabase/migrations/*.sql` in order (`20261005150000_init`, `20261005160000_waitlist`, `20261006090000_agents`) before starting the worker (Supabase SQL editor, or `supabase db push`). ✅ Applied on the live project. RLS: anon/authenticated can only SELECT
(the legacy telegram_links table is unused; no anon access); the worker writes with the service key.

## 7. Update / rollback
As deployed: rsync the working tree to `/opt/bide` (exclude `keys/`, `.env*`, `node_modules/`), `pnpm install --frozen-lockfile`, `pnpm --filter @bide/worker test`, then `pm2 reload bide-worker` as user `bide`, outside the freeze windows above. (With a git checkout: `git pull` instead of rsync.)
Laptop fallback: same code, `pnpm --filter @bide/worker start` with the root `.env` (keypair env vars may be `keys/*.json` paths locally).
Run only ONE keeper at a time (VM or laptop) — two keepers would race on the same transactions (harmless on-chain, but wastes fees and doubles desk runs).
