// Single entry point for all DB access. Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are set, else in-process.
import { cfg } from "../config.js";
import { logger } from "../log.js";
import { MemoryRepo } from "./memory.js";
import { SupabaseRepo } from "./supabase.js";
import type { Repo } from "./types.js";

export * from "./types.js";
export * from "./mappers.js";
let repo: Repo | undefined;

export function getRepo(): Repo {
  if (repo) return repo;
  if (cfg.supabaseUrl && cfg.supabaseServiceKey) repo = new SupabaseRepo(cfg.supabaseUrl, cfg.supabaseServiceKey);
  else {
    if (cfg.supabaseUrl) logger("db").warn("SUPABASE_URL SET but SUPABASE_SERVICE_KEY EMPTY — using in-process store");
    repo = new MemoryRepo();
  }
  logger("db").info("repo backend", { backend: repo.backend });
  return repo;
}
/** Tables the SupabaseRepo writes (supabase/migrations/20261005150000_init.sql). */
// The agents tables come from 20261006090000_agents.sql, which also adds rounds.asset/auction_secs/pool_delay_secs that
// roundRow() writes — so an un-migrated project must fall back to memory rather than fail every rounds upsert.
export const REQUIRED_TABLES = ["quotes", "desk_runs", "plans", "rounds", "epochs", "telegram_links", "reference_data", "maker_stances", "maker_bids", "intake_runs"] as const;

/**
 * Call once at startup, before getRepo(). With Supabase configured, probe every required table; if any is missing
 * (un-migrated project) or the probe fails, fall back to the in-process store with a warning — the worker keeps running
 * (keeper, makers, desk) and only loses persistence/realtime. Never throws.
 */
export async function initRepo(probe?: (table: string) => Promise<string | null>): Promise<Repo> {
  if (repo) return repo;
  if (!(cfg.supabaseUrl && cfg.supabaseServiceKey)) return getRepo();
  const sb = new SupabaseRepo(cfg.supabaseUrl, cfg.supabaseServiceKey);
  const p = probe ?? ((t: string) => sb.probeTable(t));
  const missing: string[] = [];
  for (const t of REQUIRED_TABLES) {
    const err = await p(t).catch((e) => String((e as Error)?.message ?? e));
    if (err) missing.push(`${t}: ${err.slice(0, 120)}`);
  }
  if (missing.length) {
    logger("db").warn("Supabase configured but not usable (tables missing / unreachable) — using in-process store; run supabase/migrations to enable it", { missing });
    repo = new MemoryRepo();
  } else repo = sb;
  logger("db").info("repo backend", { backend: repo.backend });
  return repo;
}
export function setRepoForTests(r: Repo) { repo = r; }
