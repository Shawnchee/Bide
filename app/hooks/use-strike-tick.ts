"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { AssetInfo } from "@/lib/constants";
import { useProgram } from "./use-program";

/** Strike tick for an asset: on-chain Asset.strike_tick when it exists, else the shared/default constant. */
export function useStrikeTick(asset: AssetInfo): bigint {
  const { connection } = useConnection();
  const program = useProgram();
  const [tick, setTick] = useState<bigint>(asset.strikeTick);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTick(asset.strikeTick);
    if (program.status !== "ready") return;
    let alive = true;
    program.client
      .fetchStrikeTick(connection, asset.mint)
      .then((t) => {
        if (alive && t && t > 0n) setTick(t);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [program, connection, asset]);
  return tick;
}
