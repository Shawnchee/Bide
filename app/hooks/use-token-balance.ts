"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";

/** Whole-token balance of the connected wallet. mint = null → native SOL. */
export function useTokenBalance(mint: PublicKey | null, refreshKey = 0): number | null {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [bal, setBal] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    if (!publicKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBal(null);
      return;
    }
    (async () => {
      try {
        if (!mint) {
          const l = await connection.getBalance(publicKey, "confirmed");
          if (alive) setBal(l / LAMPORTS_PER_SOL);
          return;
        }
        const ata = getAssociatedTokenAddressSync(mint, publicKey);
        const r = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
        if (alive) setBal(r ? Number(r.value.uiAmount ?? 0) : 0);
      } catch {
        if (alive) setBal(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [connection, publicKey, mint, refreshKey]);

  return bal;
}
