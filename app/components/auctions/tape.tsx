"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Addr, EmptyState, ExplorerLink } from "@/components/site/bits";
import { dateTimeUtc, toBig, toUnix, usdc, usdcPrice } from "@/lib/format";
import { fmtSize } from "@/lib/plan-math";
import type { MakerBidRow, RoundRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";
import { Fragment } from "react";
import { MakerBidList, MAKER_PERSONAS } from "@/components/agents/maker-bids";

const BOTS = (process.env.NEXT_PUBLIC_MAKER_BOTS || "").split(",").map((s) => s.trim()).filter(Boolean);

function Winner({ r }: { r: RoundRow }) {
  if (r.is_pool) return <span>Pool</span>;
  if (!r.maker) return <span className="text-muted-foreground">—</span>;
  const bot = BOTS.indexOf(r.maker);
  return (
    <span className="inline-flex items-center gap-1.5">
      {bot >= 0 ? <span>{MAKER_PERSONAS[`maker-${bot + 1}`] ?? `Maker ${bot + 1}`}</span> : <span>Outside wallet</span>}
      <Addr value={r.maker} chars={3} />
    </span>
  );
}

export function AuctionTape() {
  const rounds = useTable<RoundRow>({ table: "rounds", orderBy: "auction_start", ascending: false, limit: 100, pollMs: 10_000 });
  const roundKeys = rounds.status === "ready" ? rounds.rows.map((r) => r.round_pubkey) : [];
  const bids = useTable<MakerBidRow>({ table: "maker_bids", in: ["round_pubkey", roundKeys], limit: 400, pollMs: 10_000, enabled: roundKeys.length > 0 });
  const bidsByRound = new Map<string, MakerBidRow[]>();
  if (bids.status === "ready") for (const b of bids.rows) bidsByRound.set(b.round_pubkey, [...(bidsByRound.get(b.round_pubkey) ?? []), b]);
  if (rounds.status === "unconfigured") return <EmptyState title="Data feed not configured">The auction tape reads the keeper&apos;s round mirror.</EmptyState>;
  if (rounds.status === "loading") return <Skeleton className="h-72 w-full" />;
  if (rounds.status === "error")
    return (
      <EmptyState title="Couldn't load the tape" action={<Button variant="outline" onClick={rounds.reload}>Try again</Button>}>
        {rounds.message}
      </EmptyState>
    );
  if (rounds.rows.length === 0) return <EmptyState title="No auctions yet">Every round&apos;s auction appears here once it opens.</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <table className="data-table min-w-[60rem]">
        <thead>
          <tr>
            {["Opened", "Round", "Start", "Floor", "Maker paid", "Owner got (after fee)", "Winner", "Fee", "Status"].map((h, i) => (
              <th key={h} scope="col" className={[2, 3, 4, 5, 7].includes(i) ? "text-right" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="num">
          {rounds.rows.map((r) => {
            const fee = toBig(r.fee_paid);
            const gross = r.premium_paid != null ? toBig(r.premium_paid) : null;
            const rb = bidsByRound.get(r.round_pubkey) ?? [];
            return (
              <Fragment key={r.round_pubkey}>
              <tr className={rb.length ? "[&>td]:border-b-0" : undefined}>
                <td className="whitespace-nowrap text-muted-foreground">{dateTimeUtc(toUnix(r.auction_start ?? r.created_at ?? null))}</td>
                <td className="whitespace-nowrap">
                  <ExplorerLink address={r.round_pubkey}>
                    {String(r.kind ?? "").toLowerCase() === "call" ? "Sell" : "Buy"} {usdcPrice(r.strike)} · {fmtSize(Number(r.size) / 1e9)} SOL
                  </ExplorerLink>
                </td>
                <td className="text-right">{r.premium_start != null ? usdc(r.premium_start) : "—"}</td>
                <td className="text-right">{r.premium_floor != null ? usdc(r.premium_floor) : "—"}</td>
                <td className="text-right">{r.premium_paid != null ? usdc(r.premium_paid) : "—"}</td>
                <td className="text-right font-semibold">{gross !== null && fee !== null ? usdc(gross - fee) : "—"}</td>
                <td className="font-sans whitespace-nowrap">
                  <Winner r={r} />
                </td>
                <td className="text-right text-muted-foreground">{fee !== null ? usdc(fee) : "—"}</td>
                <td className="font-sans capitalize">{String(r.status)}</td>
              </tr>
              {rb.length > 0 && (
                <tr className="border-t-0">
                  <td colSpan={9} className="pt-0 pb-3 font-sans">
                    <MakerBidList bids={rb} roundMaker={r.maker} />
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
