"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowRight, Sprout } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/site/bits";
import { WalletButton } from "@/components/site/wallet-button";
import { dateShort, fromBase, toUnix, usdcPrice } from "@/lib/format";
import { fmtSize } from "@/lib/plan-math";
import type { PlanRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";

export function MyPlans() {
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58() ?? "";
  const plans = useTable<PlanRow>({
    table: "plans",
    eq: [["owner", owner]],
    orderBy: "updated_at",
    ascending: false,
    limit: 50,
    enabled: Boolean(owner),
    realtimeFilter: owner ? `owner=eq.${owner}` : undefined,
  });

  if (!publicKey) {
    return (
      <EmptyState title="Connect your wallet to see your plans" action={<WalletButton />}>
        Plans are tied to the wallet that signed them.
      </EmptyState>
    );
  }
  if (plans.status === "unconfigured") {
    return <EmptyState title="Data feed not configured">Your plans live on-chain; this list appears once the data feed is connected.</EmptyState>;
  }
  if (plans.status === "loading") {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (plans.status === "error") {
    return (
      <EmptyState title="Couldn't load your plans" action={<Button variant="outline" onClick={plans.reload}>Try again</Button>}>
        {plans.message}
      </EmptyState>
    );
  }
  if (plans.rows.length === 0) {
    return (
      <EmptyState
        icon={<Sprout />}
        title="No plans yet"
        action={
          <Button asChild className="rounded-full">
            <Link href="/earn">Start a plan</Link>
          </Button>
        }
      >
        Name a price and a deadline. You get paid upfront every round while you wait.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
      {plans.rows.map((p) => {
        const sell = String(p.side).toLowerCase() === "sell";
        return (
          <li key={p.plan_pubkey}>
            <Link
              href={`/plan/${p.plan_pubkey}`}
              className="group flex items-center gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset sm:px-5"
            >
              <span aria-hidden className={sell ? "grid size-8 shrink-0 place-items-center rounded-full bg-destructive/12 text-xs font-semibold text-destructive" : "grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"}>
                {sell ? "S" : "B"}
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="num truncate text-sm font-medium">
                  {sell ? "Sell" : "Buy"} {fmtSize(fromBase(p.size_total, 9) ?? 0)} SOL at {usdcPrice(p.target_strike)}
                </p>
                <p className="num text-xs text-muted-foreground">
                  until {dateShort(toUnix(p.horizon_end))} · {fmtSize(fromBase(p.size_filled, 9) ?? 0)} filled
                </p>
              </div>
              {p.quick && <Badge variant="secondary">Quick</Badge>}
              <Badge variant="outline" className="capitalize">{String(p.status)}</Badge>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
