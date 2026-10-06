"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

/** Mainnet mints the worker's Jupiter reference rows are keyed by (devnet USDC has no mainnet rate). */
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET_WSOL = "So11111111111111111111111111111111111111112";

interface RefRow {
  value: { lend?: { mint?: string; totalBps?: number }[] } | null;
}

/**
 * Jupiter Lend mainnet reference APY (bps) for USDC or SOL, from the worker's cached `reference_data`
 * row (anon-readable). Display-only fallback when the desk run didn't call lend_apy. null if unknown.
 */
export function useLendReferenceApy(asset: "USDC" | "SOL"): number | null {
  const [bps, setBps] = useState<number | null>(null);
  useEffect(() => {
    const db = getSupabase();
    if (!db) return;
    let alive = true;
    const mint = asset === "USDC" ? MAINNET_USDC : MAINNET_WSOL;
    db.from("reference_data")
      .select("value")
      .eq("key", "jupiter")
      .maybeSingle()
      .then(({ data }) => {
        const hit = (data as RefRow | null)?.value?.lend?.find((l) => l.mint === mint);
        if (alive && typeof hit?.totalBps === "number" && hit.totalBps > 0) setBps(hit.totalBps);
      });
    return () => {
      alive = false;
    };
  }, [asset]);
  return bps;
}
