"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { usdc } from "@/lib/format";
import type { MakerBidRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";
import { cn } from "@/lib/utils";
import { BUYER_STYLE, MAKER_PERSONAS, buyerName } from "./maker-bids";

interface Tally { bids: number; passes: number; ai: number; fallback: number; won: number; settled: number; pnl: bigint; worst: bigint | null }

/** Buyer profit/loss, one line per AI buyer, from maker_bids (losses included). */
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
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
      {[...by.entries()].map(([m, t]) => (
        <li key={m} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-[13px] sm:px-5">
          <span className="font-medium">
            {buyerName(m)}
            {BUYER_STYLE[m] && <span className="font-normal text-muted-foreground"> · {BUYER_STYLE[m]}</span>}
          </span>
          <span className="num text-muted-foreground">
            <span className={cn("font-semibold", t.pnl < 0n ? "text-destructive" : t.pnl > 0n ? "text-positive" : "text-foreground")}>
              {t.settled ? `${t.pnl >= 0n ? "+" : ""}${usdc(t.pnl)}` : "—"}
            </span>{" "}
            over {t.settled} finished {t.settled === 1 ? "round" : "rounds"} · won {t.won} · bid {t.bids}, passed {t.passes}
            {t.fallback > 0 && <> · backup bot {t.fallback}×</>}
            {t.worst !== null && t.worst < 0n && <> · worst {usdc(t.worst)}</>}
          </span>
        </li>
      ))}
    </ul>
  );
}
