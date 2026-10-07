// Public (browser-safe) configuration. Server-only values live in lib/server/*.
/** Unset → the browser uses the /api/rpc proxy (see components/providers.tsx). */
export const RPC_URL: string | undefined = process.env.NEXT_PUBLIC_RPC_URL || undefined;
export const CLUSTER = "devnet" as const;

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const QUICK_PLANS_ENABLED = (process.env.NEXT_PUBLIC_QUICK_PLANS_ENABLED ?? "1") === "1";

/** Address lookup table holding the Jupiter Lend accounts (published by the P lane). */
export const LEND_ALT = process.env.NEXT_PUBLIC_LEND_ALT || "";
