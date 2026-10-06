"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getBideClient, type BideProgramClient } from "@/lib/bide-client";
import { PROGRAM_ID } from "@/lib/constants";

export type ProgramState = { status: "checking" } | { status: "missing" } | { status: "ready"; client: BideProgramClient };

/** Program client, gated on the Bide program actually being deployed on devnet. */
export function useProgram(): ProgramState {
  const { connection } = useConnection();
  const [state, setState] = useState<ProgramState>({ status: "checking" });
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const info = await connection.getAccountInfo(PROGRAM_ID);
        if (!alive) return;
        setState(info?.executable ? { status: "ready", client: getBideClient(connection)! } : { status: "missing" });
      } catch {
        if (alive) setState((s) => (s.status === "ready" ? s : { status: "missing" }));
      }
    };
    check();
    const t = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connection]);
  return state;
}
