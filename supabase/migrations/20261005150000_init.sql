-- Bide schema (BUILD §7). Worker writes with the service key (bypasses RLS); anon/authenticated may only SELECT.
-- Amounts are stored as numeric (u64 on-chain can exceed bigint's signed range in theory; numeric is exact).

create table if not exists public.quotes (
  id bigint generated always as identity primary key,
  asset text not null,
  ts timestamptz not null default now(),
  fair_iv double precision,
  bid_iv double precision,
  venues jsonb not null default '[]'::jsonb,
  quick_pricing boolean not null default false,
  -- extra context for the UI / desk (what was priced)
  kind text,               -- put | call
  strike numeric,
  expiry timestamptz,
  spot double precision,
  fair_premium numeric,    -- USDC base units for `size`
  bid_premium numeric,
  premium_start numeric,
  premium_floor numeric
);
create index if not exists quotes_asset_ts on public.quotes (asset, ts desc);

create table if not exists public.desk_runs (
  id uuid primary key default gen_random_uuid(),
  plan_pubkey text,
  kind text not null check (kind in ('preview', 'round')),
  steps jsonb not null default '[]'::jsonb,
  proposal jsonb,
  verdict jsonb,
  final jsonb,
  memo jsonb,
  card jsonb,               -- plain-English card from the desk (worker/src/desk/card.ts)
  memo_hash text,
  tx_sig text,
  error_code text,
  status text not null default 'running',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists desk_runs_plan on public.desk_runs (plan_pubkey, created_at desc);
create index if not exists desk_runs_created on public.desk_runs (created_at desc);

create table if not exists public.plans (
  plan_pubkey text primary key,
  owner text not null,
  asset text not null,
  side text not null,
  phase text,
  quick boolean not null default false,
  target_strike numeric,
  exit_strike numeric,
  size_total numeric,
  size_filled numeric,
  horizon_end timestamptz,
  status text not null,
  updated_at timestamptz not null default now()
);
create index if not exists plans_owner on public.plans (owner);

create table if not exists public.rounds (
  round_pubkey text primary key,
  plan_pubkey text not null,
  kind text,
  strike numeric,
  size numeric,
  notional numeric,
  expiry timestamptz,
  auction_start timestamptz,
  premium_start numeric,
  premium_floor numeric,
  premium_paid numeric,
  fee_paid numeric,
  maker text,
  is_pool boolean not null default false,
  status text not null,
  settle_price numeric,
  exercised smallint,
  memo_hash text,
  sigs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists rounds_plan on public.rounds (plan_pubkey);
create index if not exists rounds_status on public.rounds (status);

create table if not exists public.epochs (
  epoch_pubkey text primary key,
  asset text not null,
  kind text not null,
  expiry timestamptz not null,
  samples jsonb not null default '[]'::jsonb,
  sample_mask integer not null default 0,
  settle_price numeric,
  status text not null,
  updated_at timestamptz not null default now()
);
create index if not exists epochs_expiry on public.epochs (expiry desc);

create table if not exists public.telegram_links (
  wallet text not null,
  chat_id bigint not null,
  plan_pubkey text,
  created_at timestamptz not null default now(),
  primary key (wallet, chat_id)
);

-- Cached reference data (Jupiter Lend APY / price — mainnet reference only, never settlement).
create table if not exists public.reference_data (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS: anon/authenticated can SELECT public tables; nobody but the service role writes.
alter table public.quotes enable row level security;
alter table public.desk_runs enable row level security;
alter table public.plans enable row level security;
alter table public.rounds enable row level security;
alter table public.epochs enable row level security;
alter table public.reference_data enable row level security;
alter table public.telegram_links enable row level security; -- no anon policy: wallet↔chat_id stays private

create policy "anon read quotes" on public.quotes for select to anon, authenticated using (true);
create policy "anon read desk_runs" on public.desk_runs for select to anon, authenticated using (true);
create policy "anon read plans" on public.plans for select to anon, authenticated using (true);
create policy "anon read rounds" on public.rounds for select to anon, authenticated using (true);
create policy "anon read epochs" on public.epochs for select to anon, authenticated using (true);
create policy "anon read reference_data" on public.reference_data for select to anon, authenticated using (true);

-- Realtime for the app (/desk feed, /plan timeline, /auctions tape).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.desk_runs, public.rounds, public.plans, public.epochs;
  end if;
end $$;
