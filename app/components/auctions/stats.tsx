"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/site/bits";
import { toBig } from "@/lib/format";
import type { RoundRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";

const usd4 = (base: bigint) => `$${(Number(base) / 1e6).toFixed(4)}`;

/** Totals across every round the keeper mirrored. Net = premium_paid − fee_paid. No annualised figures. */
export function AuctionStats() {
  const rounds = useTable<Pick<RoundRow, "premium_paid" | "fee_paid" | "strike" | "size">>({
    table: "rounds",
    select: "premium_paid,fee_paid,strike,size",
    limit: 5000,
    pollMs: 30_000,
  });
  if (rounds.status === "unconfigured" || rounds.status === "error") return null;
  if (rounds.status === "loading") return <Skeleton className="mb-8 h-24 w-full" />;

  let filled = 0;
  let net = 0n;
  let fees = 0n;
  let pctSum = 0;
  let pctN = 0;
  for (const r of rounds.rows) {
    const paid = toBig(r.premium_paid) ?? 0n;
    if (paid <= 0n) continue;
    const fee = toBig(r.fee_paid) ?? 0n;
    filled++;
    net += paid - fee;
    fees += fee;
    // notional (USDC base units) = size (lamports) × strike (USDC base units) / 1e9
    const notional = (Number(toBig(r.size) ?? 0n) * Number(toBig(r.strike) ?? 0n)) / 1e9;
    if (notional > 0) {
      pctSum += Number(paid - fee) / notional;
      pctN++;
    }
  }

  if (filled === 0)
    return <p className="mb-8 text-xs text-muted-foreground">No rounds filled yet. Totals appear after the first paid round.</p>;

  return (
    <section aria-label="Round totals" className="mb-8 grid gap-2">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-4">
        <div className="bg-card p-4">
          <Stat label="Rounds filled" value={filled} />
        </div>
        <div className="bg-card p-4">
          <Stat label="Paid to users after fee" value={usd4(net)} />
        </div>
        <div className="bg-card p-4">
          <Stat label="Avg premium per round" value={pctN ? `${((pctSum / pctN) * 100).toFixed(3)}%` : "—"} sub="of notional, after fee" />
        </div>
        <div className="bg-card p-4">
          <Stat label="Bide fees" value={usd4(fees)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Daily rounds pay far more than 10-minute ones; devnet Lend pays ≈ $0.</p>
    </section>
  );
}
