"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Addr, EmptyState, ExplorerLink } from "@/components/site/bits";
import { dateTimeUtc, toBig, toUnix, usdc, usdcPrice } from "@/lib/format";
import { fmtSize } from "@/lib/plan-math";
import type { MakerBidRow, RoundRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";
import { cn } from "@/lib/utils";
import { MakerBidList, bidWon, buyerName } from "@/components/agents/maker-bids";

const BOTS = (process.env.NEXT_PUBLIC_MAKER_BOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Same "exercised" rule as worker/src/agents/outcomes.ts: resolved/settled rounds with exercised === 2. */
function result(r: RoundRow): {
  label: string;
  hint: string;
  tone: "pos" | "neutral" | "muted";
} {
  const s = String(r.status).toLowerCase();
  if (s === "auction" || s === "live") return { label: "Running", hint: "waiting for round end", tone: "neutral" };
  if (s === "cancelled") return { label: "No buyer", hint: "nothing happened", tone: "muted" };
  if (s === "unwound") return { label: "Undone", hint: "money returned", tone: "muted" };
  if (r.exercised === 2 || r.exercised === true)
    return {
      label: "Filled",
      hint: `you ${String(r.kind ?? "").toLowerCase() === "call" ? "sold" : "bought"} at your price`,
      tone: "pos",
    };
  return { label: "Not filled", hint: "you kept your money", tone: "neutral" };
}

function whoPaid(r: RoundRow): { name: string; outside?: string } | null {
  if (r.is_pool) return { name: "Backstop" };
  if (!r.maker) return null;
  const i = BOTS.indexOf(r.maker);
  return i >= 0 ? { name: buyerName(`maker-${i + 1}`) } : { name: "Outside buyer", outside: r.maker };
}

/** First sentence of a buyer's thesis, capped for the table; the full text is under "Both bids". */
function shortQuote(t: string): string {
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
}

const COLS = "sm:grid-cols-[8.5rem_minmax(0,1.3fr)_6rem_minmax(0,2fr)_8rem]";

export function AuctionTape() {
  const rounds = useTable<RoundRow>({
    table: "rounds",
    orderBy: "auction_start",
    ascending: false,
    limit: 100,
    pollMs: 10_000,
  });
  const roundKeys = rounds.status === "ready" ? rounds.rows.map((r) => r.round_pubkey) : [];
  const bids = useTable<MakerBidRow>({
    table: "maker_bids",
    in: ["round_pubkey", roundKeys],
    limit: 400,
    pollMs: 10_000,
    enabled: roundKeys.length > 0,
  });
  const bidsByRound = new Map<string, MakerBidRow[]>();
  if (bids.status === "ready") for (const b of bids.rows) bidsByRound.set(b.round_pubkey, [...(bidsByRound.get(b.round_pubkey) ?? []), b]);
  if (rounds.status === "unconfigured") return <EmptyState title="Data feed not configured">Connect the data feed to see rounds.</EmptyState>;
  if (rounds.status === "loading") return <Skeleton className="h-72 w-full" />;
  if (rounds.status === "error")
    return (
      <EmptyState
        title="Couldn't load rounds"
        action={
          <Button variant="outline" onClick={rounds.reload}>
            Try again
          </Button>
        }
      >
        {rounds.message}
      </EmptyState>
    );
  if (rounds.rows.length === 0) return <EmptyState title="No rounds yet">Each round shows here once it opens.</EmptyState>;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className={cn("hidden gap-4 border-b border-border px-5 py-2.5 text-xs font-medium text-muted-foreground sm:grid", COLS)}>
        <span>Time</span>
        <span>Plan</span>
        <span className="text-right" title="Upfront pay (the premium), after Bide's fee">
          Paid to you
        </span>
        <span>Who paid</span>
        <span>Result</span>
      </div>
      <ol className="divide-y divide-border">
        {rounds.rows.map((r) => {
          const fee = toBig(r.fee_paid);
          const gross = r.premium_paid != null ? toBig(r.premium_paid) : null;
          const net = gross !== null && gross > 0n && fee !== null ? gross - fee : null;
          const rb = bidsByRound.get(r.round_pubkey) ?? [];
          const winBid = rb.find((b) => bidWon(b, r.maker));
          const who = whoPaid(r);
          const res = result(r);
          const allPassed = rb.length > 0 && rb.every((b) => b.stance === "pass" || b.bid === null);
          return (
            <li key={r.round_pubkey} className={cn("grid gap-x-4 gap-y-1.5 px-4 py-3 text-[13px] sm:items-start sm:px-5", COLS)}>
              <span className="num text-xs text-muted-foreground sm:pt-0.5">{dateTimeUtc(toUnix(r.auction_start ?? r.created_at ?? null))}</span>
              <span className="min-w-0">
                <ExplorerLink address={r.round_pubkey}>
                  {String(r.kind ?? "").toLowerCase() === "call" ? "Sell" : "Buy"} {fmtSize(Number(r.size) / 1e9)} SOL at {usdcPrice(r.strike)}
                </ExplorerLink>
              </span>
              <span className="num sm:text-right">
                <span className="text-xs text-muted-foreground sm:hidden">Paid to you </span>
                <span className="font-semibold">{net !== null ? usdc(net) : "—"}</span>
              </span>
              <div className="grid min-w-0 gap-1">
                {who ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{who.name}</span>
                    {who.outside && <Addr value={who.outside} chars={3} />}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{allPassed ? "Both AI buyers passed" : "Nobody yet"}</span>
                )}
                {winBid?.thesis && <p className="line-clamp-2 text-xs text-pretty text-muted-foreground">&ldquo;{shortQuote(winBid.thesis)}&rdquo;</p>}
                {rb.length > 0 && (
                  <details className="text-xs">
                    <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">Both bids</summary>
                    <MakerBidList bids={rb} roundMaker={r.maker} className="mt-2 sm:grid-cols-1 lg:grid-cols-2" />
                  </details>
                )}
              </div>
              <span className="text-xs">
                <span className={cn("font-medium", res.tone === "pos" ? "text-positive" : res.tone === "muted" ? "text-muted-foreground" : "")}>
                  {res.label}
                </span>
                <span className="text-muted-foreground"> — {res.hint}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
