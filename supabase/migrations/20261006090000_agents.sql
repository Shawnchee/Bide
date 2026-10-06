-- Bide AI agents v2 (docs/ai-agents.md, as revised 2026-10-06): maker agent stances + per-round bid ledger with P&L,
-- intake runs, and the rounds columns that the desk's deterministic `recent_outcomes` tool needs.
-- Worker writes with the service key (bypasses RLS). anon/authenticated may only SELECT the public tables.
-- No LLM "lessons" table: reflection memory was cut in favour of deterministic outcome statistics.

-- rounds: asset + auction timing (seconds-to-fill is derived from start/floor/paid/auction_secs).
alter table public.rounds add column if not exists asset text;
alter table public.rounds add column if not exists auction_secs integer;
alter table public.rounds add column if not exists pool_delay_secs integer;
create index if not exists rounds_asset_start on public.rounds (asset, auction_start desc);
create index if not exists rounds_plan_start on public.rounds (plan_pubkey, auction_start desc);

-- One stance per maker per (asset, epoch, round kind). Decided before the auction window; rounds derive bids from it.
create table if not exists public.maker_stances (
  id uuid primary key default gen_random_uuid(),
  stance_key text not null,              -- '<asset_pubkey>:<epoch_pubkey>:<put|call>'
  asset text not null,
  epoch_pubkey text not null,
  expiry timestamptz not null,
  kind text not null check (kind in ('put', 'call')),
  maker text not null,                   -- 'maker-1' | 'maker-2'
  persona text not null,
  source text not null check (source in ('llm', 'fallback')),
  model text,
  stance text check (stance in ('bid', 'pass')),
  spread_pct double precision,
  thesis text,
  confidence double precision,
  grounded boolean,
  fallback_reason text,
  context jsonb,                         -- the public market inputs the maker saw (no desk memo, no plan bounds)
  stance_hash text not null,             -- sha256 of canonical JSON of the stance record
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists maker_stances_key on public.maker_stances (stance_key, maker, created_at desc);
create index if not exists maker_stances_created on public.maker_stances (created_at desc);

-- Per-maker, per-round bid ledger. pnl_usdc = settlement value − premium paid (USDC base units), set at resolve.
create table if not exists public.maker_bids (
  id uuid primary key default gen_random_uuid(),
  round_pubkey text not null,
  plan_pubkey text not null,
  maker text not null,
  maker_pubkey text not null,
  stance_id uuid references public.maker_stances (id),
  source text not null check (source in ('llm', 'fallback')),
  stance text not null check (stance in ('bid', 'pass')),
  spread_pct double precision,
  fair_at_bid numeric,                   -- consensus CEX fair premium for this round (USDC base units, total)
  bid numeric,                           -- null when the maker passed
  thesis text,
  confidence double precision,
  reason text,                           -- fallback reason / clamp note
  bid_hash text not null,
  took boolean not null default false,
  tx_sig text,
  pnl_usdc numeric,                      -- signed; losses included
  created_at timestamptz not null default now()
);
create index if not exists maker_bids_round on public.maker_bids (round_pubkey);
create index if not exists maker_bids_plan on public.maker_bids (plan_pubkey, created_at desc);
create index if not exists maker_bids_maker on public.maker_bids (maker, created_at desc);

-- Intake: free text → draft form fields. User text: no anon access.
create table if not exists public.intake_runs (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  fields jsonb,
  assumptions jsonb,
  questions jsonb,
  model text,
  error text,
  latency_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.maker_stances enable row level security;
alter table public.maker_bids enable row level security;
alter table public.intake_runs enable row level security; -- no anon policy: user free text stays private

drop policy if exists "anon read maker_stances" on public.maker_stances;
create policy "anon read maker_stances" on public.maker_stances for select to anon, authenticated using (true);
drop policy if exists "anon read maker_bids" on public.maker_bids;
create policy "anon read maker_bids" on public.maker_bids for select to anon, authenticated using (true);

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'maker_bids') then
    alter publication supabase_realtime add table public.maker_bids;
  end if;
end $$;
