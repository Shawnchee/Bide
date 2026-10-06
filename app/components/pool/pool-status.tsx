"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ExplorerLink } from "@/components/site/bits";
import { useProgram } from "@/hooks/use-program";
import type { DecodedPool } from "@/lib/bide-client";

const num = (n: number, dp = 2) => n.toLocaleString("en-US", { maximumFractionDigits: dp });

/** Live pool account on devnet: balances + the on-chain caps that bound what it can spend. */
export function PoolStatus() {
  const { connection } = useConnection();
  const program = useProgram();
  const client = program.status === "ready" ? program.client : null;
  const [pool, setPool] = useState<DecodedPool | null | "error">(null);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    const load = () =>
      client
        .fetchPool(connection)
        .then((p) => alive && setPool(p ?? "error"))
        .catch(() => alive && setPool((s) => (s && s !== "error" ? s : "error")));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, connection]);

  if (pool === "error") {
    return <p className="text-xs text-muted-foreground">Couldn&apos;t read the pool account from devnet right now.</p>;
  }
  if (!pool) {
    return (
      <div className="grid gap-2 rounded-2xl border border-border bg-card p-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  const usdc = pool.usdcVault + pool.lendFTokens;
  return (
    <section aria-labelledby="pool-live-h" className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="pool-live-h" className="text-sm font-semibold">
          {pool.paused ? "Pool is paused" : "Pool is live on devnet"}
        </h2>
        <ExplorerLink address={pool.pubkey} />
      </div>
      <p className="text-[13px] text-muted-foreground">
        {pool.paused
          ? "The pool account exists but isn't taking rounds right now."
          : "It backstops auctions: when no trader takes a round, the pool can take it at the floor price once the pool window opens."}
      </p>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">USDC</dt>
          <dd className="num mt-0.5 text-sm font-semibold">
            {num(usdc)}
            {pool.lendFTokens > 0 && <span className="block text-[11px] font-normal text-muted-foreground">≈{num(pool.lendFTokens)} in Jupiter Lend</span>}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">SOL (wrapped)</dt>
          <dd className="num mt-0.5 text-sm font-semibold">{num(pool.wsolVault, 4)}</dd>
        </div>
      </dl>
      <div className="grid gap-1 border-t border-border pt-3 text-[13px]">
        <p className="text-xs font-medium text-muted-foreground">On-chain caps</p>
        <ul className="grid gap-1">
          <li>Pays at most {num(pool.maxPremiumBpsOfNotional / 100)}% of a round&apos;s size upfront</li>
          <li>
            Open rounds up to <span className="num">{num(pool.maxOpenNotional)}</span> USDC in total (now <span className="num">{num(pool.openNotional)}</span>)
          </li>
          <li>At most {num(pool.maxUtilizationBps / 100)}% of the pool locked at once</li>
          <li>
            Spends at most <span className="num">{num(pool.spendWindowCap)}</span> USDC per{" "}
            {pool.spendWindowSecs === 86_400 ? "day" : `${num(pool.spendWindowSecs / 3600, 1)} h`} (used{" "}
            <span className="num">{num(pool.spendWindowSpent)}</span>)
          </li>
        </ul>
      </div>
    </section>
  );
}
