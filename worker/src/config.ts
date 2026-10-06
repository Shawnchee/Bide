// Env loading. Values are never logged — only NAME + SET/EMPTY via envReport().
import { config as dotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// Local dev: repo-root .env. On the VM, pm2 passes an env file; dotenv never overrides set vars.
dotenv({ path: path.resolve(here, "../../.env"), quiet: true } as any);
dotenv({ path: path.resolve(here, "../.env"), quiet: true } as any);

const env = (n: string) => {
  const v = process.env[n];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

export const cfg = {
  rpcUrl: env("HELIUS_RPC_URL") ?? "https://api.devnet.solana.com",
  rpcFallbackUrl: "https://api.devnet.solana.com",
  programId: env("PROGRAM_ID"),
  usdcMint: env("USDC_MINT") ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  hermesUrl: env("HERMES_URL") ?? "https://hermes.pyth.network",
  hermesBetaUrl: env("HERMES_BETA_URL") ?? "https://hermes-beta.pyth.network",
  pythHermesApiKey: env("PYTH_HERMES_API_KEY"),
  jupApiKey: env("JUP_API_KEY"),
  supabaseUrl: env("SUPABASE_URL"),
  supabaseServiceKey: env("SUPABASE_SERVICE_KEY"),
  workerSharedSecret: env("WORKER_SHARED_SECRET"),
  quickPlansEnabled: (env("QUICK_PLANS_ENABLED") ?? "1") === "1",
  port: Number(env("PORT") ?? 8787),
  // Loop toggles so the HTTP/pricer can run without keys (e.g. before the program is deployed).
  enableKeeper: (env("ENABLE_KEEPER") ?? "1") === "1",
  enableMakers: (env("ENABLE_MAKERS") ?? "1") === "1",
};

/** Keypair env names. Each may hold a JSON array / base58 secret, or (local dev) a path to a keys/*.json file. */
export const KEYPAIR_ENVS = ["KEEPER_KEYPAIR", "MAKER1_KEYPAIR", "MAKER2_KEYPAIR", "MAKER3_KEYPAIR"] as const;

const REPORTED = [
  "HELIUS_RPC_URL", "PROGRAM_ID", "USDC_MINT", "PYTH_HERMES_API_KEY", "JUP_API_KEY",
  "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "WORKER_SHARED_SECRET", "QUICK_PLANS_ENABLED", ...KEYPAIR_ENVS,
];
export function envReport(): Record<string, "SET" | "EMPTY"> {
  return Object.fromEntries(REPORTED.map((n) => [n, env(n) ? "SET" : "EMPTY"]));
}
export { env as readEnv };
