"use client";

import { useEffect, useState } from "react";
import { DAY } from "@/lib/plan-math";

export interface RoundEstimate {
  /** Round expiry the estimate is for (unix seconds). */
  expiry: number;
  /** Gross pay per 1 whole unit of the asset, dollars: the auction floor and fair value. */
  floorPerUnit: number;
  fairPerUnit: number;
  /** Probability the round fills (settles through the user's price), 0–1. */
  fillProbability: number | null;
  venues: number;
}

export type RoundEstimateState =
  | { status: "idle" }
  | { status: "loading"; last: RoundEstimate | null }
  | { status: "ready"; est: RoundEstimate }
  | { status: "error"; message: string };

const DEBOUNCE_MS = 700;

/**
 * The expiry the estimate prices. Quick: the next 10-minute epoch a round can still open for.
 * Std: next Friday 08:00 UTC (the worker's default), capped at the plan's end. The desk picks the real one.
 */
export function estimateExpiry(now: number, quick: boolean, end: number | null): number {
  if (quick) return (Math.floor(now / 600) + 2) * 600;
  let e = Math.floor(now / DAY) * DAY + 8 * 3600;
  if (e <= now) e += DAY;
  // Unix day 0 is a Thursday, so day % 7 === 1 is a Friday.
  while (Math.floor(e / DAY) % 7 !== 1) e += DAY;
  return end && end < e ? end : e;
}

/** Live, debounced price estimate for one round from the worker's 4-venue options pricer. Never an LLM. */
export function useRoundEstimate(input: {
  symbol: string;
  kind: "put" | "call";
  strike: number | null;
  expiry: number | null;
  quick: boolean;
  /** Plan end: later fallback expiries never go past it. */
  end?: number | null;
}): RoundEstimateState {
  const { symbol, kind, strike, expiry, quick, end } = input;
  const [state, setState] = useState<RoundEstimateState>({ status: "idle" });

  useEffect(() => {
    if (!strike || !expiry) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: "idle" });
      return;
    }
    setState((s) => ({ status: "loading", last: s.status === "ready" ? s.est : s.status === "loading" ? s.last : null }));
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        // A price far from spot often isn't listed on the nearest expiry; the desk would pick a longer round
        // for it too, so a standard plan also tries the next two Fridays (never past the plan's end).
        const tries = quick ? [expiry] : [expiry, expiry + 7 * DAY, expiry + 14 * DAY].filter((e, i) => i === 0 || !end || e <= end);
        let q: { ok?: boolean; floor?: number | string; fairPremium?: number | string; fillProbability?: number; venues?: unknown[] } | undefined;
        let used = expiry;
        for (const e of tries) {
          const qs = new URLSearchParams({ kind, strike: String(strike), expiry: String(e) });
          if (quick) qs.set("quick", "1");
          const res = await fetch(`/api/quotes/${symbol}?${qs}`, { signal: ctrl.signal });
          const body = (await res.json().catch(() => null)) as { quote?: typeof q } | null;
          if (!res.ok || !body?.quote) return setState({ status: "error", message: "Live quotes are unavailable right now." });
          q = body.quote;
          used = e;
          if (q.ok) break;
        }
        if (!q?.ok) return setState({ status: "error", message: "No live quote for this price and date. Try a price closer to now." });
        setState({
          status: "ready",
          est: {
            expiry: used,
            floorPerUnit: Number(q.floor) / 1e6,
            fairPerUnit: Number(q.fairPremium) / 1e6,
            fillProbability: typeof q.fillProbability === "number" ? q.fillProbability : null,
            venues: Array.isArray(q.venues) ? q.venues.length : 0,
          },
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setState({ status: "error", message: "Live quotes are unavailable right now." });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [symbol, kind, strike, expiry, quick, end]);

  return state;
}
