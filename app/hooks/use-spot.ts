"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchPushFeedSpot, type PythSpot } from "@/lib/pyth";
import type { AssetInfo } from "@/lib/constants";

export type SpotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; spot: PythSpot };

/** Live Pyth spot from the devnet sponsored push feed (refreshes every 30 s). */
export function useSpot(asset: AssetInfo): SpotState {
  const { connection } = useConnection();
  const [state, setState] = useState<SpotState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const spot = await fetchPushFeedSpot(connection, asset.pushFeed);
        if (!alive) return;
        setState(spot ? { status: "ready", spot } : { status: "error", message: "Price feed not found." });
      } catch {
        if (alive) setState((s) => (s.status === "ready" ? s : { status: "error", message: "Couldn't reach the price feed." }));
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connection, asset.pushFeed]);

  return state;
}
