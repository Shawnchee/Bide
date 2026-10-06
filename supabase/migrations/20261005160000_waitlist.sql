-- Landing-page waitlist (app/app/api/waitlist/route.ts inserts with the anon key).
-- RLS: anon may INSERT only. No SELECT/UPDATE/DELETE policies, so emails are never readable with the anon key.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (char_length(email) <= 200),
  target_note text check (target_note is null or char_length(target_note) <= 80), -- "at what price would you buy SOL?"
  wallet text check (wallet is null or char_length(wallet) between 32 and 44),
  source text not null default 'landing' check (char_length(source) <= 40),
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

drop policy if exists "anon insert waitlist" on public.waitlist;
create policy "anon insert waitlist" on public.waitlist
  for insert to anon, authenticated
  with check (true);

-- Table privileges: insert only for API roles (RLS above still applies).
revoke all on public.waitlist from anon, authenticated;
grant insert on public.waitlist to anon, authenticated;
