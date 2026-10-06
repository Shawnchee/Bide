"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { usdc } from "@/lib/format";
import type { MakerBidRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";
import { cn } from "@/lib/utils";
import { MAKER_PERSONAS, makerLabel } from "./maker-bids";

interface Tally { bids: number; passes: number; ai: number; fallback: number; won: number; settled: number; pnl: bigint; worst: bigint | null }

/** Per-maker P&L ledger from maker_bids (losses included). */
export function MakerLedger() {
  const rows = useTable<MakerBidRow>({ table: "maker_bids", orderBy: "created_at", ascending: false, limit: 1000, pollMs: 15_000 });
  if (rows.status === "unconfigured" || rows.status === "error") return null;
  if (rows.status === "loading") return <Skeleton className="h-36 w-full" />;
  const by = new Map<string, Tally>();
  for (const m of Object.keys(MAKER_PERSONAS)) by.set(m, { bids: 0, passes: 0, ai: 0, fallback: 0, won: 0, settled: 0, pnl: 0n, worst: null });
  for (const b of rows.rows) {
    const t = by.get(b.maker) ?? { bids: 0, passes: 0, ai: 0, fallback: 0, won: 0, settled: 0, pnl: 0n, worst: null };
    by.set(b.maker, t);
    if (b.stance === "pass" || b.bid === null) t.passes++;
    else t.bids++;
    if (b.source === "llm") t.ai++;
    else t.fallback++;
    if (b.took) t.won++;
    if (b.took && b.pnl_usdc !== null) {
      const p = BigInt(String(b.pnl_usdc).split(".")[0]!);
      t.settled++;
      t.pnl += p;
      t.worst = t.worst === null || p < t.worst ? p : t.worst;
    }
  }
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
      {[...by.entries()].map(([m, t]) => (
        <div key={m} className="grid gap-3 bg-card p-4 sm:p-5">
          <p className="text-xs font-medium text-muted-foreground">{makerLabel(m)}</p>
          <div>
            <p className={cn("num text-3xl leading-none font-semibold tracking-tight", t.pnl < 0n ? "text-destructive" : t.pnl > 0n ? "text-positive" : "")}>
              {t.settled ? `${t.pnl >= 0n ? "+" : ""}${usdc(t.pnl)}` : "—"}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              cumulative P&amp;L over {t.settled} settled {t.settled === 1 ? "round" : "rounds"} (settlement value − premium paid)
            </p>
          </div>
          <dl className="num grid grid-cols-3 gap-2 border-t border-border pt-3 text-[13px] font-medium [&_dt]:text-xs [&_dt]:font-normal">
            <div>
              <dt className="font-sans text-muted-foreground">Won</dt>
              <dd>{t.won}</dd>
            </div>
            <div>
              <dt className="font-sans text-muted-foreground">Bids / passes</dt>
              <dd>
                {t.bids} / {t.passes}
              </dd>
            </div>
            <div>
              <dt className="font-sans text-muted-foreground">AI / fallback</dt>
              <dd>
                {t.ai} / {t.fallback}
              </dd>
            </div>
          </dl>
          {t.worst !== null && t.worst < 0n && <p className="num text-xs text-destructive">Worst round: {usdc(t.worst)}</p>}
        </div>
      ))}
    </div>
  );
}
