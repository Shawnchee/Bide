"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ASSETS } from "@/lib/constants";
import { dateShort } from "@/lib/format";
import { fmtPrice, presetPrice } from "@/lib/plan-math";
import { useSpot } from "@/hooks/use-spot";
import { useNow } from "@/hooks/use-now";

/** Hero card built from the live Pyth price — no invented numbers. */
export function LiveExample() {
  const spot = useSpot(ASSETS.SOL);
  const now = useNow(60_000);
  const s = spot.status === "ready" ? spot.spot.price : null;
  const target = s ? presetPrice(s, "balanced", true, false, ASSETS.SOL.strikeTick) : null;
  const by = now ? dateShort(now + 30 * 86400) : null;

  return (
    <div className="relative grid gap-2 rounded-3xl border border-border bg-card p-3 sm:p-4">
      <div className="swap-panel">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">SOL right now</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" aria-hidden /> Pyth · devnet
        </span>
      </div>
      {s ? <p className="num mt-1.5 text-3xl font-semibold tracking-tight">${fmtPrice(s)}</p> : <Skeleton className="mt-1.5 h-9 w-32" />}
      </div>
      <div className="swap-panel swap-panel-outline">
      <p className="text-xs font-medium text-muted-foreground">You could say</p>
      {target && by ? (
        <p className="mt-2 text-[22px] leading-snug font-semibold tracking-tight">
          &ldquo;Buy SOL at <span className="text-primary">${fmtPrice(target)}</span> by {by}.&rdquo;
        </p>
      ) : (
        <Skeleton className="mt-2 h-16 w-full" />
      )}
      </div>
      <p className="px-2 py-2 text-[13px] text-muted-foreground">Paid each round, plus Jupiter Lend interest.</p>
      <Link
        href="/earn"
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none active:translate-y-px"
      >
        See what you&apos;d be paid <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}
