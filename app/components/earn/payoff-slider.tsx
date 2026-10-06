"use client";

import { useState } from "react";
import { Slider } from "@/components/ui/slider";
import { dateShort, usd } from "@/lib/format";
import { fmtPrice, payoff, type Goal } from "@/lib/plan-math";
import { cn } from "@/lib/utils";

interface Props {
  goal: Goal;
  symbol: string;
  strike: number;
  size: number;
  premiumNet: number | null;
  lendYield: number | null;
  checkAt: number | null;
  spot: number | null;
}

/** "If SOL ends at $X on <date>, you get …" — pure code (SPEC §4 feature 8). */
export function PayoffSlider({ goal, symbol, strike, size, premiumNet, lendYield, checkAt, spot }: Props) {
  const lo = Math.max(1, Math.floor(strike * 0.6));
  const hi = Math.ceil(strike * 1.4);
  const [settle, setSettle] = useState(() => Math.round(spot && spot >= lo && spot <= hi ? spot : strike));
  if (!strike || !size) return null;
  const r = payoff({ goal, strike, size, premiumNet, lendYield, settle }, symbol);
  const when = checkAt ? `on ${dateShort(checkAt)}` : "at the check";

  return (
    <section aria-labelledby="payoff-h" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 id="payoff-h" className="text-sm font-semibold">
        Try a price
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Drag to see what you&apos;d end up with for this round.</p>

      <div className="mt-4 grid gap-3 rounded-xl bg-secondary p-4">
        <p className="text-[15px]">
          If {symbol} ends at <span className="num text-lg font-semibold tracking-tight">${fmtPrice(settle)}</span> {when}:
        </p>
        <Slider min={lo} max={hi} step={1} value={[settle]} onValueChange={([v]) => setSettle(v)} aria-label={`${symbol} price at the check`} />
        <div className="relative h-5 text-xs text-muted-foreground">
          <span className="num absolute left-0">${fmtPrice(lo)}</span>
          <span className="num absolute -translate-x-1/2" style={{ left: `${((strike - lo) / (hi - lo)) * 100}%` }}>
            your price ${fmtPrice(strike)}
          </span>
          <span className="num absolute right-0">${fmtPrice(hi)}</span>
        </div>
      </div>

      <div
        className={cn(
          "mt-3 grid gap-1 rounded-xl border p-4 transition-colors duration-200",
          r.filled ? "border-primary/25 bg-accent text-accent-foreground" : "border-border bg-transparent text-foreground",
        )}
        aria-live="polite"
      >
        <p className="text-sm font-semibold">{r.headline}</p>
        <p className="text-[13px] opacity-85">{r.detail}</p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Paid to you upfront</dt>
          <dd className="num mt-0.5 text-sm font-semibold text-foreground">{premiumNet !== null ? usd(premiumNet) : "set at auction"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Lend interest (est.)</dt>
          <dd className="num mt-0.5 text-sm font-semibold text-foreground">{lendYield !== null ? usd(lendYield) : "—"}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-muted-foreground">Worth at ${fmtPrice(settle)}</dt>
          <dd className="num mt-0.5 text-sm font-semibold text-foreground">{usd(r.endValue)}</dd>
        </div>
      </dl>
      {premiumNet === null && (
        <p className="mt-3 text-xs text-muted-foreground">Upfront pay isn&apos;t included until the desk prices the round.</p>
      )}
    </section>
  );
}
