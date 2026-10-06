"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Repeat, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ASSETS, type AssetSymbol } from "@/lib/constants";
import { QUICK_PLANS_ENABLED } from "@/lib/env";
import {
  buildDraft,
  fmtPrice,
  fmtSize,
  horizonEnd,
  MIN_PAY_PRESETS,
  nearestPatience,
  presetPrice,
  snapDollars,
  tickDollars,
  validateHorizon,
  type Goal,
  type HorizonChoice,
  type MinPayId,
} from "@/lib/plan-math";
import { dateShort } from "@/lib/format";
import type { Patience } from "@/lib/types";
import { useSpot } from "@/hooks/use-spot";
import { useStrikeTick } from "@/hooks/use-strike-tick";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { HowItWorks } from "./how-it-works";
import { Review } from "./review";
import { IntakeBox, type IntakeFields } from "./intake-box";

const GOALS: { id: Goal; label: string; sub: string; icon: typeof ArrowDownRight }[] = [
  { id: "buy", label: "Buy cheaper", sub: "Get SOL at your price", icon: ArrowDownRight },
  { id: "sell", label: "Sell higher", sub: "Sell your SOL at your price", icon: ArrowUpRight },
  { id: "both", label: "Both", sub: "Buy low, then sell high", icon: Repeat },
];

const PATIENCE: { id: Patience; label: string; sub: string }[] = [
  { id: "patient", label: "Patient", sub: "Far from today's price · pays less · fills less often" },
  { id: "balanced", label: "Balanced", sub: "In between" },
  { id: "eager", label: "Eager", sub: "Close to today's price · pays more · fills more often" },
];

const STD_HORIZONS: { id: HorizonChoice; label: string }[] = [
  { id: "1w", label: "1 week" },
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "date", label: "Pick a date" },
];
const QUICK_HORIZONS: { id: HorizonChoice; label: string }[] = [
  { id: "q30m", label: "30 min" },
  { id: "q1h", label: "1 hour" },
  { id: "q3h", label: "3 hours" },
];

function Question({ n, title, hint, children, id }: { n: number; title: string; hint?: string; children: React.ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="grid gap-3 border-t border-border px-4 py-5 first:border-t-0 sm:grid-cols-[2rem_1fr] sm:px-6">
      <span className="num hidden size-6 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-muted-foreground sm:grid" aria-hidden>
        {n}
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <h2 id={id} className="text-[15px] font-semibold tracking-tight">
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

function Choice({
  selected,
  onClick,
  children,
  className,
  disabled,
  ...rest
}: { selected: boolean; onClick: () => void; children: React.ReactNode; className?: string; disabled?: boolean } & React.AriaAttributes) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-[border-color,background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-primary/70 bg-accent text-accent-foreground [&_.text-muted-foreground]:text-accent-foreground/75" : "border-border bg-secondary/40 hover:border-input hover:bg-secondary",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function EarnFlow() {
  const now = useNow(30_000);
  const [goal, setGoal] = useState<Goal>("buy");
  const [assetSym, setAssetSym] = useState<AssetSymbol>("SOL");
  const baseAsset = ASSETS[assetSym];
  const tick = useStrikeTick(baseAsset);
  // On-chain Asset.strike_tick wins over the default constant.
  const asset = useMemo(() => ({ ...baseAsset, strikeTick: tick }), [baseAsset, tick]);
  const td = tickDollars(tick);
  const priceText = (v: number) => (td < 1 ? v.toFixed(2) : String(v));
  const [quick, setQuick] = useState(false);
  const [patience, setPatience] = useState<Patience>("balanced");
  const [target, setTarget] = useState<number | null>(null);
  const [targetText, setTargetText] = useState("");
  const [exitText, setExitText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [horizon, setHorizon] = useState<HorizonChoice>("1m");
  const [customDate, setCustomDate] = useState("");
  const [minPay, setMinPay] = useState<MinPayId>("standard");
  const [step, setStep] = useState<"form" | "review">("form");
  const [touched, setTouched] = useState(false);
  /** Intake result waiting to be applied after the preset effects below have run (they reset target/horizon). */
  const [intake, setIntake] = useState<IntakeFields | null>(null);
  /** The assistant couldn't settle a price: keep the field empty and flagged instead of falling back to a preset. */
  const [priceNeeded, setPriceNeeded] = useState(false);

  const spotState = useSpot(asset);
  const spot = spotState.status === "ready" ? spotState.spot.price : null;
  const buySide = goal !== "sell";

  // Initialise / re-snap the target when spot arrives or the side/quick mode changes.
  useEffect(() => {
    if (!spot || priceNeeded) return;
    const p = presetPrice(spot, patience, buySide, quick, tick);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget(p);
    setTargetText(priceText(p));
    if (goal === "both" && !exitText) setExitText(priceText(snapDollars(spot * 1.1, tick, true)));
    // Only when these change, not on every patience click (handled in pickPatience).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spot !== null, goal, quick, assetSym, tick]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHorizon(quick ? "q1h" : "1m");
  }, [quick]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  // Apply an intake result. Declared after the preset effects so it runs after them in the same commit.
  useEffect(() => {
    if (!intake) return;
    const f = intake;
    const qk = f.quick ?? quick;
    const buy = (f.goal ?? goal) !== "sell";
    // Stated patience is a preference the desk/Risk weigh (size, expiry); it never picks the price.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must run after the preset effects above in the same commit
    if (f.patience) setPatience(f.patience);
    if (f.target_price_usd) {
      const snapped = snapDollars(f.target_price_usd, tick, !buy);
      setPriceNeeded(false);
      setTarget(snapped);
      setTargetText(priceText(snapped));
      if (spot && !f.patience) {
        const near = nearestPatience(spot, snapped, buy, qk);
        if (near) setPatience(near);
      }
    } else {
      // Price still open: leave it visibly empty rather than silently showing a preset the user never chose.
      setPriceNeeded(true);
      setTarget(null);
      setTargetText("");
    }
    if (f.exit_price_usd) setExitText(priceText(snapDollars(f.exit_price_usd, tick, true)));
    if (f.amount) setAmountText(String(f.amount));
    if (f.horizon && (qk ? f.horizon.startsWith("q") : !f.horizon.startsWith("q"))) setHorizon(f.horizon);
    if (f.horizon === "date" && f.deadline_date) setCustomDate(f.deadline_date);
    if (f.min_pay) setMinPay(f.min_pay);
    setIntake(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intake]);

  const applyIntake = (f: IntakeFields) => {
    if (f.goal) setGoal(f.goal);
    if (f.asset && ASSETS[f.asset as AssetSymbol]?.enabled) setAssetSym(f.asset as AssetSymbol);
    if (f.quick !== null && QUICK_PLANS_ENABLED) setQuick(f.quick);
    setIntake(f);
  };

  const pickPatience = (p: Patience) => {
    setPatience(p);
    if (spot) {
      setPriceNeeded(false);
      const v = presetPrice(spot, p, buySide, quick, tick);
      setTarget(v);
      setTargetText(priceText(v));
    }
  };

  const onTargetText = (s: string) => {
    setTargetText(s);
    const v = Number(s);
    if (Number.isFinite(v) && v > 0) {
      setPriceNeeded(false);
      setTarget(v);
      if (spot) {
        const near = nearestPatience(spot, v, buySide, quick);
        if (near) setPatience(near);
      }
    }
  };

  /** Snap the typed price to the tick grid (buy: down, sell: up) when the field loses focus. */
  const snapTyped = () => {
    const v = Number(targetText);
    if (!(v > 0)) return;
    const snapped = snapDollars(v, tick, !buySide);
    setTarget(snapped);
    setTargetText(priceText(snapped));
  };

  // Slider works in whole ticks so every stop is a valid on-chain price.
  const sliderRange = useMemo(() => {
    if (!spot) return null;
    const [a, b] = quick ? (buySide ? [0.97, 1] : [1, 1.03]) : buySide ? [0.6, 1] : [1, 1.6];
    return [snapDollars(spot * a, tick, true), snapDollars(spot * b, tick, false)];
  }, [spot, buySide, quick, tick]);
  const toTicks = (d: number) => Math.round(d / td);
  /** Which preset (if any) the current price sits on; drives the radio highlight. */
  const activePreset = spot && target ? nearestPatience(spot, target, buySide, quick) : null;

  const amount = Number(amountText);
  const exitDollars = goal === "both" ? Number(exitText) || null : null;
  const end = now ? horizonEnd(horizon, now, customDate) : null;
  const horizonError = now ? validateHorizon(end, now, quick) : null;
  const minPayBps = MIN_PAY_PRESETS.find((m) => m.id === minPay)!.bps;

  const draft = useMemo(() => {
    if (!target || !end || !now) return null;
    return buildDraft({
      goal,
      asset,
      quick,
      targetDollars: target,
      exitDollars,
      amount: Number.isFinite(amount) ? amount : 0,
      horizonEnd: end,
      minPayBps,
      now,
    });
  }, [goal, asset, quick, target, exitDollars, amount, end, minPayBps, now]);

  const sizeWhole = draft ? Number(draft.args.sizeTotal) / 10 ** asset.decimals : 0;
  const strikeDollars = draft ? Number(draft.args.targetStrike) / 1e6 : 0;
  const exitStrikeDollars = draft ? Number(draft.args.exitStrike) / 1e6 : 0;

  const formError =
    !target ? "Enter the price you want." : !amount || amount <= 0 ? "Enter an amount." : horizonError ?? draft?.error ?? null;

  const sentence = (() => {
    if (!draft || !target) return null;
    const by = end ? (quick ? new Date(end * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : dateShort(end)) : "…";
    const sz = sizeWhole > 0 ? `${fmtSize(sizeWhole)} ` : "";
    if (goal === "buy") return `Buy ${sz}${asset.symbol} at $${fmtPrice(strikeDollars)}, trying until ${by}.`;
    if (goal === "sell") return `Sell ${sz}${asset.symbol} at $${fmtPrice(strikeDollars)}, trying until ${by}.`;
    return `Buy ${sz}${asset.symbol} at $${fmtPrice(strikeDollars)}, then sell it at $${exitDollars ? fmtPrice(exitStrikeDollars) : "—"}, trying until ${by}.`;
  })();

  if (step === "review" && draft && end) {
    return (
      <Review
        goal={goal}
        asset={asset}
        draft={draft}
        sentence={sentence ?? ""}
        patience={patience}
        horizonEnd={end}
        spot={spot}
        onBack={() => setStep("form")}
      />
    );
  }

  return (
    <>
    <div className="mb-6 max-w-2xl">
      <p className="text-xs font-medium text-primary">Start a plan</p>
      <h1 className="mt-1 font-display text-2xl leading-tight text-balance sm:text-[28px]">Name your price. Get paid until it fills.</h1>
    </div>
    <IntakeBox onApply={applyIntake} />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <form
        className="min-w-0 self-start rounded-2xl border border-border bg-card"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!formError) setStep("review");
        }}
        noValidate
      >
        <Question n={1} title="What do you want to do?" id="q-goal">
          <div role="radiogroup" aria-labelledby="q-goal" className="grid gap-2 sm:grid-cols-3">
            {GOALS.map((g) => (
              <Choice key={g.id} selected={goal === g.id} onClick={() => setGoal(g.id)}>
                <span className="flex items-center gap-2 font-medium">
                  <g.icon className="size-4 text-primary" aria-hidden /> {g.label}
                </span>
                <span className="text-xs text-muted-foreground">{g.sub}</span>
              </Choice>
            ))}
          </div>
        </Question>

        <Question n={2} title="Which asset?" id="q-asset">
          <div role="radiogroup" aria-labelledby="q-asset" className="flex flex-wrap gap-2">
            {(Object.keys(ASSETS) as AssetSymbol[]).map((s) => (
              <Choice
                key={s}
                selected={assetSym === s}
                disabled={!ASSETS[s].enabled}
                onClick={() => setAssetSym(s)}
                className="min-w-28 flex-row items-center gap-2 rounded-full px-4"
              >
                <span className="font-medium">{s}</span>
                {!ASSETS[s].enabled && <span className="text-xs text-muted-foreground">coming soon</span>}
              </Choice>
            ))}
          </div>
          {QUICK_PLANS_ENABLED && (
            <div className="flex items-start gap-3 rounded-xl bg-secondary/50 p-3.5">
              <Switch id="quick" checked={quick} onCheckedChange={setQuick} className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor="quick" className="flex items-center gap-1.5 font-medium">
                  <Timer className="size-4" aria-hidden /> Quick plan — 10-minute rounds
                </Label>
                <p className="text-xs text-muted-foreground">
                  Optional. Same program, real prices, real Jupiter Lend. Each round settles after 10 minutes, so you can watch a whole cycle
                  in one sitting. Pays cents, priced with the nearest listed exchange option (labelled &ldquo;quick-plan pricing&rdquo;).
                </p>
              </div>
            </div>
          )}
        </Question>

        <Question
          n={3}
          title={goal === "sell" ? "At what price do you want to sell?" : "At what price do you want to buy?"}
          hint={
            spot
              ? `${asset.symbol} is $${fmtPrice(spot)} right now (Pyth).`
              : spotState.status === "error"
                ? `${spotState.message} You can still type a price.`
                : undefined
          }
          id="q-target"
        >
          <div role="radiogroup" aria-label="How patient are you?" className="grid gap-2 sm:grid-cols-3">
            {PATIENCE.map((p) => (
              <Choice key={p.id} selected={!priceNeeded && activePreset === p.id} onClick={() => pickPatience(p.id)} disabled={!spot}>
                <span className="font-medium">{p.label}</span>
                <span className="text-xs text-muted-foreground">
                  {spot ? `$${fmtPrice(presetPrice(spot, p.id, buySide, quick, tick))} · ` : ""}
                  {p.sub}
                </span>
              </Choice>
            ))}
          </div>
          {spotState.status === "loading" ? (
            <Skeleton className="h-10 w-full" />
          ) : sliderRange ? (
            <div className="grid gap-2 pt-1">
              <Slider
                min={toTicks(sliderRange[0])}
                max={toTicks(sliderRange[1])}
                step={1}
                value={[Math.min(Math.max(toTicks(target ?? sliderRange[0]), toTicks(sliderRange[0])), toTicks(sliderRange[1]))]}
                onValueChange={([k]) => onTargetText(priceText(Number((k * td).toFixed(6))))}
                aria-label="Target price"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span className="num">${fmtPrice(sliderRange[0])}</span>
                <span>{buySide ? "← cheaper, fills less often" : "fills more often →"}</span>
                <span className="num">${fmtPrice(sliderRange[1])}</span>
              </div>
            </div>
          ) : null}
          <div className={cn("swap-panel", priceNeeded && "border-primary ring-2 ring-primary/40")}>
            <Label htmlFor="target" className="text-xs font-medium text-muted-foreground">
              {goal === "sell" ? "Sell at" : "Buy at"} · or type a price
            </Label>
            <div className="mt-2 flex items-center gap-3">
              <span className="text-2xl font-medium text-muted-foreground" aria-hidden>$</span>
              <input
                id="target"
                inputMode="decimal"
                autoComplete="off"
                className="swap-input"
                value={targetText}
                placeholder="0.00"
                required
                onChange={(e) => onTargetText(e.target.value.replace(/[^0-9.]/g, ""))}
                onBlur={snapTyped}
                aria-invalid={(touched || priceNeeded) && !target}
                aria-describedby={priceNeeded ? "target-needed target-hint" : "target-hint"}
              />
              <span className="swap-pill">USD / {asset.symbol}</span>
            </div>
            {priceNeeded && (
              <p id="target-needed" className="mt-2 text-sm font-medium text-primary">
                Your price is still to decide — pick one of the options above or type a price.
              </p>
            )}
            <p id="target-hint" className="mt-2 text-xs text-muted-foreground">
              Prices move in ${fmtPrice(td)} steps; we round {buySide ? "down" : "up"} to the nearest one.
            </p>
          </div>
          {goal === "both" && (
            <div className="swap-panel swap-panel-outline">
              <Label htmlFor="exit" className="text-xs font-medium text-muted-foreground">Then sell it at</Label>
              <div className="mt-2 flex items-center gap-3">
                <span className="text-2xl font-medium text-muted-foreground" aria-hidden>$</span>
                <input
                  id="exit"
                  inputMode="decimal"
                  autoComplete="off"
                  className="swap-input"
                  value={exitText}
                  onChange={(e) => setExitText(e.target.value.replace(/[^0-9.]/g, ""))}
                  onBlur={() => {
                    const v = Number(exitText);
                    if (v > 0) setExitText(priceText(snapDollars(v, tick, true)));
                  }}
                  aria-invalid={touched && Boolean(draft?.error)}
                />
                <span className="swap-pill">USD / {asset.symbol}</span>
              </div>
            </div>
          )}
        </Question>

        <Question n={4} title="How much?" hint={buySide ? "In USDC. This is what you set aside to buy with." : `In ${asset.symbol}. This is what you'd sell.`} id="q-amount">
          <div className="swap-panel">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="amount" className="text-xs font-medium text-muted-foreground">
                {buySide ? "You set aside" : "You'd sell"}
              </Label>
              <div className="flex gap-1">
                {(buySide ? ["20", "100", "500"] : ["0.2", "1", "5"]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="num inline-flex h-7 min-w-10 items-center justify-center rounded-full border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:border-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => setAmountText(v)}
                  >
                    {buySide ? `$${v}` : v}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder={buySide ? "0.00" : "0.0"}
                className="swap-input"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
                aria-invalid={touched && !(amount > 0)}
              />
              <span className="swap-pill">{buySide ? "USDC" : asset.symbol}</span>
            </div>
            {draft && amount > 0 && target && buySide && (
              <p className="mt-2 text-xs text-muted-foreground">
                ≈ <span className="num text-foreground">{fmtSize(sizeWhole)} {asset.symbol}</span> at ${fmtPrice(strikeDollars)}
              </p>
            )}
          </div>
        </Question>

        <Question n={5} title="By when?" hint={quick ? "Quick plans run for a few hours at most." : "If it hasn't filled by then, everything comes back to you automatically."} id="q-when">
          <div role="radiogroup" aria-labelledby="q-when" className="flex flex-wrap gap-2">
            {(quick ? QUICK_HORIZONS : STD_HORIZONS).map((h) => (
              <Choice key={h.id} selected={horizon === h.id} onClick={() => setHorizon(h.id)} className="min-h-10 justify-center rounded-full px-4 py-2">
                <span className="text-sm font-medium">{h.label}</span>
              </Choice>
            ))}
          </div>
          {horizon === "date" && (
            <div className="grid max-w-xs gap-1.5">
              <Label htmlFor="date">Deadline (max 6 months)</Label>
              <Input
                id="date"
                type="date"
                className="h-10"
                value={customDate}
                min={now ? new Date((now + 86400 * 2) * 1000).toISOString().slice(0, 10) : undefined}
                max={now ? new Date((now + 86400 * 179) * 1000).toISOString().slice(0, 10) : undefined}
                onChange={(e) => setCustomDate(e.target.value)}
              />
            </div>
          )}
          {horizonError && (touched || horizon === "date") && <p className="text-sm text-destructive">{horizonError}</p>}
        </Question>

        <Question n={6} title="Minimum pay per round" hint="The program refuses any round that pays you less than this, after our fee." id="q-min">
          <div role="radiogroup" aria-labelledby="q-min" className="grid gap-2 sm:grid-cols-3">
            {MIN_PAY_PRESETS.map((m) => (
              <Choice key={m.id} selected={minPay === m.id} onClick={() => setMinPay(m.id)}>
                <span className="num font-medium">{m.label}</span>
                <span className="text-xs text-muted-foreground">{m.hint}</span>
              </Choice>
            ))}
          </div>
        </Question>

        <div className="flex flex-col gap-3 border-t border-border p-4 sm:px-6">
          <Button type="submit" size="lg" className="h-12 w-full rounded-xl text-base">
            Preview my plan
          </Button>
          {touched && formError && (
            <p className="text-sm text-destructive" role="alert">
              {formError}
            </p>
          )}
        </div>
      </form>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-xs font-medium text-muted-foreground">Your plan</p>
          <p className="mt-2 text-lg leading-snug font-semibold tracking-tight text-balance">
            {sentence ?? <span className="text-muted-foreground">Pick a price and an amount.</span>}
          </p>
          <ul className="mt-4 grid gap-2 text-[13px] text-muted-foreground">
            <li>You get paid upfront every round, filled or not.</li>
            <li>Your {buySide ? "USDC" : asset.symbol} earns Jupiter Lend interest while it waits.</li>
            <li>Stop anytime between rounds.</li>
          </ul>
          <div className="mt-4 border-t border-border pt-3">
            <HowItWorks />
          </div>
        </div>
      </aside>
    </div>
    </>
  );
}
