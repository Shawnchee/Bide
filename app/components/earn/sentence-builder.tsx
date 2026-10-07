"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_FEE_BPS, type AssetInfo } from "@/lib/constants";
import { afterFee, fmtPrice, fmtSize, presetPrice, type Goal, type HorizonChoice } from "@/lib/plan-math";
import { dateShort } from "@/lib/format";
import type { Patience } from "@/lib/types";
import type { RoundEstimateState } from "@/hooks/use-round-estimate";
import { cn } from "@/lib/utils";

type Tone = "amber" | "violet" | "peach" | "mint";

/** A coloured word in the sentence that opens a small menu. Closes on outside click, Escape, or a pick. */
function Pill({
  tone,
  label,
  children,
  ariaLabel,
  invalid,
}: {
  tone: Tone;
  label: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  ariaLabel: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Horizontal shift (px, ≤ 0) that keeps the 16rem menu inside the viewport on narrow screens. */
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={wrap} className="relative inline-block align-baseline">
      <button
        type="button"
        className="word-pill"
        data-tone={tone}
        data-invalid={invalid || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          const left = wrap.current?.getBoundingClientRect().left ?? 0;
          setShift(Math.min(0, window.innerWidth - 16 - (left + 256)));
          setOpen((o) => !o);
        }}
      >
        {label}
        <ChevronDown className="size-[0.55em] opacity-70" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="dialog"
          aria-label={ariaLabel}
          style={{ left: shift }}
          className="absolute top-full z-30 mt-2 grid w-64 max-w-[calc(100vw-2rem)] gap-1 rounded-xl border border-border bg-popover p-2 text-left font-sans text-sm font-normal tracking-normal text-popover-foreground shadow-xl"
        >
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}

function Item({ selected, onClick, children }: { selected?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}

/** A small typed input inside a pill menu; applies on Enter or the Set button. */
function CustomInput({ prefix, suffix, initial, placeholder, onSet }: { prefix?: string; suffix?: string; initial: string; placeholder: string; onSet: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="mt-1 flex items-center gap-2 border-t border-border pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (Number(v) > 0) onSet(v);
      }}
    >
      <span className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-lg bg-secondary px-2.5 focus-within:ring-2 focus-within:ring-ring/40">
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        <input
          inputMode="decimal"
          autoComplete="off"
          aria-label={placeholder}
          placeholder={placeholder}
          className="num w-full min-w-0 bg-transparent outline-none"
          value={v}
          onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </span>
      <Button type="submit" size="sm" variant="soft" className="h-9 rounded-lg">
        Set
      </Button>
    </form>
  );
}

const PATIENCE: { id: Patience; label: string; sub: string }[] = [
  { id: "patient", label: "Patient", sub: "pays less, fills less" },
  { id: "balanced", label: "Balanced", sub: "in between" },
  { id: "eager", label: "Eager", sub: "pays more, fills more" },
];

const STD: { id: HorizonChoice; label: string }[] = [
  { id: "1w", label: "1 week" },
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
];
const QUICK: { id: HorizonChoice; label: string }[] = [
  { id: "q30m", label: "30 minutes" },
  { id: "q1h", label: "1 hour" },
  { id: "q3h", label: "3 hours" },
];

export interface SentenceBuilderProps {
  goal: Goal;
  onGoal: (g: Goal) => void;
  asset: AssetInfo;
  spot: number | null;
  target: number | null;
  priceText: (v: number) => string;
  activePreset: Patience | null;
  onPreset: (p: Patience) => void;
  onTypedPrice: (s: string) => void;
  amountText: string;
  onAmount: (s: string) => void;
  sizeWhole: number;
  strikeDollars: number;
  quick: boolean;
  quickEnabled: boolean;
  horizon: HorizonChoice;
  onHorizon: (h: HorizonChoice, quick: boolean) => void;
  customDate: string;
  onCustomDate: (d: string) => void;
  dates: { min: string; max: string } | null;
  end: number | null;
  estimate: RoundEstimateState;
  error: string | null;
  showError: boolean;
  onPreview: () => void;
  onDetailed: () => void;
}

/** "I want to buy $20 of SOL at $117.70 by Nov 7": the plan as one sentence of coloured, editable words. */
export function SentenceBuilder(p: SentenceBuilderProps) {
  const buy = p.goal !== "sell";
  const pct = p.spot && p.target ? ((p.target - p.spot) / p.spot) * 100 : null;
  const amount = Number(p.amountText);
  const horizons = [...STD, ...(p.quickEnabled ? QUICK : [])];
  const horizonLabel = (h: HorizonChoice) => [...STD, ...QUICK].find((x) => x.id === h)?.label ?? "";
  const byWord = p.quick ? "within" : "by";
  const byLabel = p.quick ? horizonLabel(p.horizon) : p.end ? dateShort(p.end) : "pick a date";

  const est = p.estimate.status === "ready" ? p.estimate.est : p.estimate.status === "loading" ? p.estimate.last : null;
  const size = p.sizeWhole > 0 ? p.sizeWhole : 0;
  const payLo = est && size ? afterFee(est.floorPerUnit * size, DEFAULT_FEE_BPS) : null;
  const payHi = est && size ? afterFee(est.fairPerUnit * size, DEFAULT_FEE_BPS) : null;
  const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  const roundEnd = est ? (p.quick ? new Date(est.expiry * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : dateShort(est.expiry)) : null;

  return (
    <section aria-labelledby="sentence-h" className="mb-6 rounded-2xl border border-border bg-card p-5 sm:p-8">
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <span id="sentence-h" className="rounded-full bg-secondary px-2.5 py-1 font-medium text-foreground">
          {buy ? "Buy plan" : "Sell plan"}
        </span>
        {p.spot && (
          <span className="num inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            {p.asset.symbol} ${fmtPrice(p.spot)} <span className="hidden sm:inline">(Pyth)</span>
          </span>
        )}
        {p.quick && <span className="rounded-full bg-warning-soft px-2.5 py-1 font-medium text-warning-foreground">Quick plan · 10-minute rounds</span>}
      </div>

      <div className="sentence font-display text-[26px] leading-[1.7] text-balance sm:text-[38px]">
        I want to{" "}
        <Pill tone="peach" ariaLabel="Buy or sell" label={<>{buy ? "buy" : "sell"} {buy ? <TrendingDown className="size-[0.6em]" aria-hidden /> : <TrendingUp className="size-[0.6em]" aria-hidden />}</>}>
          {(close) => (
            <>
              <Item selected={buy} onClick={() => (p.onGoal("buy"), close())}>
                <span className="font-medium">Buy cheaper</span>
                <span className="text-xs text-muted-foreground">pay USDC, get {p.asset.symbol}</span>
              </Item>
              <Item selected={!buy} onClick={() => (p.onGoal("sell"), close())}>
                <span className="font-medium">Sell higher</span>
                <span className="text-xs text-muted-foreground">sell your {p.asset.symbol}</span>
              </Item>
            </>
          )}
        </Pill>{" "}
        <Pill
          tone="amber"
          ariaLabel={buy ? "How much USDC" : `How much ${p.asset.symbol}`}
          invalid={p.showError && !(amount > 0)}
          label={<span className="num">{amount > 0 ? (buy ? `$${p.amountText}` : `${p.amountText} ${p.asset.symbol}`) : buy ? "$ amount" : "amount"}</span>}
        >
          {(close) => (
            <>
              {(buy ? ["20", "100", "500"] : ["0.2", "1", "5"]).map((v) => (
                <Item key={v} selected={p.amountText === v} onClick={() => (p.onAmount(v), close())}>
                  <span className="num font-medium">{buy ? `$${v} USDC` : `${v} ${p.asset.symbol}`}</span>
                </Item>
              ))}
              <CustomInput prefix={buy ? "$" : undefined} suffix={buy ? "USDC" : p.asset.symbol} initial={p.amountText} placeholder="Other amount" onSet={(v) => (p.onAmount(v), close())} />
            </>
          )}
        </Pill>{" "}
        {buy ? "of" : ""}{buy ? " " : ""}
        {buy && (
          <>
            <span className="word-pill word-pill-static" data-tone="violet">
              {p.asset.symbol}
            </span>{" "}
          </>
        )}
        at{" "}
        <Pill
          tone="mint"
          ariaLabel={buy ? "Buy at what price" : "Sell at what price"}
          invalid={p.showError && !p.target}
          label={
            <span className="num inline-flex items-center gap-[0.25em]">
              {p.target ? `$${fmtPrice(p.target)}` : "$ price"}
              {pct !== null && Math.abs(pct) >= 0.05 && (
                <span className="rounded-full bg-background/60 px-[0.4em] py-[0.1em] text-[0.4em] font-semibold tracking-normal">
                  {pct > 0 ? "↑" : "↓"}
                  {Math.abs(pct).toFixed(pct > -1 && pct < 1 ? 1 : 0)}%
                </span>
              )}
            </span>
          }
        >
          {(close) => (
            <>
              {PATIENCE.map((x) => (
                <Item key={x.id} selected={p.activePreset === x.id} onClick={() => (p.onPreset(x.id), close())}>
                  <span>
                    <span className="font-medium">{x.label}</span>
                    {p.quick && x.id === "eager" && <span className="ml-1.5 text-xs text-primary">best for quick</span>}
                    <span className="block text-xs text-muted-foreground">{x.sub}</span>
                  </span>
                  {p.spot && <span className="num text-muted-foreground">${fmtPrice(presetPrice(p.spot, x.id, buy, p.quick, p.asset.strikeTick))}</span>}
                </Item>
              ))}
              <CustomInput prefix="$" suffix={`USD / ${p.asset.symbol}`} initial={p.target ? p.priceText(p.target) : ""} placeholder="Your price" onSet={(v) => (p.onTypedPrice(v), close())} />
            </>
          )}
        </Pill>{" "}
        {byWord}{" "}
        <Pill tone="violet" ariaLabel="By when" invalid={p.showError && !p.end} label={<span className="num">{byLabel}</span>}>
          {(close) => (
            <>
              {horizons.map((h) => {
                const isQuick = h.id.startsWith("q");
                return (
                  <Item key={h.id} selected={p.horizon === h.id} onClick={() => (p.onHorizon(h.id, isQuick), close())}>
                    <span className="font-medium">{h.label}</span>
                    {isQuick && <span className="text-xs text-muted-foreground">quick · 10-min rounds</span>}
                  </Item>
                );
              })}
              {p.dates && (
                <label className="mt-1 flex items-center justify-between gap-2 border-t border-border px-1 pt-2 text-xs text-muted-foreground">
                  Or a date
                  <input
                    type="date"
                    className="h-9 rounded-lg bg-secondary px-2 text-sm text-foreground"
                    min={p.dates.min}
                    max={p.dates.max}
                    value={p.customDate}
                    onChange={(e) => {
                      p.onCustomDate(e.target.value);
                      close();
                    }}
                  />
                </label>
              )}
            </>
          )}
        </Pill>
        .
      </div>

      <div className="mt-6 flex flex-wrap items-stretch gap-3">
        <div className="min-w-[10rem] rounded-xl bg-secondary px-4 py-3">
          <p className="text-xs text-muted-foreground">You get paid each round</p>
          <p className="num mt-0.5 text-xl font-semibold text-primary">
            {payLo !== null && payHi !== null ? (money(payLo) === money(payHi) ? `≈ ${money(payHi)}` : `${money(payLo)}–${money(payHi)}`) : "—"}
          </p>
        </div>
        <div className="min-w-[10rem] rounded-xl bg-secondary px-4 py-3">
          <p className="text-xs text-muted-foreground">Chance it fills that round</p>
          <p className="num mt-0.5 text-xl font-semibold">{est?.fillProbability != null ? `${Math.round(est.fillProbability * 100)}%` : "—"}</p>
        </div>
        {buy && size > 0 && (
          <div className="min-w-[10rem] rounded-xl bg-secondary px-4 py-3">
            <p className="text-xs text-muted-foreground">If it fills, you get</p>
            <p className="num mt-0.5 text-xl font-semibold">
              {fmtSize(size)} {p.asset.symbol}
            </p>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
        {p.estimate.status === "error"
          ? p.estimate.message
          : p.estimate.status === "loading" && !est
            ? "Pricing from live options quotes…"
            : est && roundEnd
              ? `Estimate for a round ending ${roundEnd}, from ${est.venues} exchange${est.venues === 1 ? "" : "s"}' live options quotes, after Bide's fee. Paid filled or not. The desk sets the real pay and may split the amount across rounds.`
              : "Pick an amount and a price to see the pay."}
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="button" size="lg" className="h-12 rounded-xl px-6 text-base sm:min-w-56" onClick={p.onPreview}>
          Preview my plan
        </Button>
        <button type="button" onClick={p.onDetailed} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Use the detailed form
        </button>
      </div>
      {p.showError && p.error && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {p.error}
        </p>
      )}
    </section>
  );
}
