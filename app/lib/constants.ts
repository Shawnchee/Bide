import { PublicKey } from "@solana/web3.js";
import * as shared from "@bide/shared";

/** Default SOL strike tick: on-chain Asset.strike_tick wins (useStrikeTick); then @bide/shared; then $0.10. */
function sharedTick(): bigint | null {
  const s = shared as unknown as Record<string, unknown>;
  const v = s.SOL_STRIKE_TICK ?? (s.STRIKE_TICKS as Record<string, unknown> | undefined)?.SOL;
  try {
    return v !== undefined && v !== null ? BigInt(v as string | number | bigint) : null;
  } catch {
    return null;
  }
}

// Mirrors BUILD §2 / §3.7. Switch to @bide/shared constants once the P lane publishes them.
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe",
);
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const USDC_DECIMALS = 6;

export type AssetSymbol = "SOL" | "BTC";

export interface AssetInfo {
  symbol: AssetSymbol;
  name: string;
  mint: PublicKey;
  decimals: number;
  /** USDC base units per strike tick (default; the on-chain Asset value wins). */
  strikeTick: bigint;
  /** Pyth sponsored push feed (upgraded program set, shard 0) — BUILD §3.7. */
  pushFeed: PublicKey;
  enabled: boolean;
}

export const ASSETS: Record<AssetSymbol, AssetInfo> = {
  SOL: {
    symbol: "SOL",
    name: "Solana",
    mint: WSOL_MINT,
    decimals: 9,
    strikeTick: sharedTick() ?? 100_000n,
    pushFeed: new PublicKey("7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE"),
    enabled: true,
  },
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    // tBTC test mint is created later (BUILD Phase 7); BTC stays disabled until then.
    mint: WSOL_MINT,
    decimals: 8,
    strikeTick: 250_000_000n,
    pushFeed: new PublicKey("APgzQGGdv2qCgBkX6aHVkrGePtBVDDg68GiqaM7rmtf5"),
    enabled: false,
  },
};

/** Config.fee_bps default (10% of every premium) — BUILD §3.2. Read on-chain once the IDL lands. */
export const DEFAULT_FEE_BPS = 1000;

/** Every Lend-CPI transaction requests 400k CU — BUILD §3.3. */
export const LEND_CU_LIMIT = 400_000;

export const EXPLORER = "https://explorer.solana.com";
export const explorerTx = (sig: string) => `${EXPLORER}/tx/${sig}?cluster=devnet`;
export const explorerAddress = (addr: string) => `${EXPLORER}/address/${addr}?cluster=devnet`;
