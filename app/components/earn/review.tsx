"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_FEE_BPS, USDC_MINT, type AssetInfo } from "@/lib/constants";
import { PROGRAM_NOT_READY } from "@/lib/bide-client";
import { collapseSteps, fillProbability, lendApy, riskSummary, runRiskAnswers } from "@/lib/desk";
import { dateShort, dateTimeUtc, usd } from "@/lib/format";
import { afterFee, fmtPrice, fmtSize, type Draft, type Goal } from "@/lib/plan-math";
import { planPda } from "@bide/shared";
import { sendAndConfirm } from "@/lib/send";
import { buildCreatePlanTx, explainTxError } from "@/lib/tx";
import type { Patience } from "@/lib/types";
import { useDeskPreview } from "@/hooks/use-desk-preview";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { useNow } from "@/hooks/use-now";
import { useLendReferenceApy } from "@/hooks/use-lend-reference";
import { WalletButton } from "@/components/site/wallet-button";
import { ExplorerLink } from "@/components/site/bits";
import { useProgram } from "@/hooks/use-program";
import { PayoffSlider } from "./payoff-slider";

interface Props {
  goal: Goal;
  asset: AssetInfo;
  draft: Draft;
  sentence: string;
  patience: Patience;
  horizonEnd: number;
  spot: number | null;
  onBack: () => void;
}

export function Review({ goal, asset, draft, sentence, patience, horizonEnd, spot, onBack }: Props) {
  const { state, run, retry } = useDeskPreview();
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "building" | "signing" | "confirming">("idle");
  const [txError, setTxError] = useState<string | null>(null);

  const nowSec = useNow(60_000);
  const usdcBal = useTokenBalance(USDC_MINT);
  const solBal = useTokenBalance(null);

  useEffect(() => {
    const a = draft.args;
    run({
      asset: asset.symbol,
      side: a.side,
      quick: a.quick,
      target_strike: a.targetStrike.toString(),
      exit_strike: a.exitStrike.toString(),
      size_total: a.sizeTotal.toString(),
      lock_strike: a.lockStrike,
      min_premium_bps_per_day: a.minPremiumBpsPerDay,
      max_expiry_secs: a.maxExpirySecs,
      max_rounds_per_day: a.maxRoundsPerDay,
      horizon_end: a.horizonEnd,
      patience,
      owner: publicKey?.toBase58(),
    });
    // Run once per review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = "data" in state ? state.data : null;
  const proposal = (data?.final?.proposal ?? null) as {
    premium_floor?: string;
    premium_start?: string;
    expiry?: number;
    size?: string;
  } | null;
  const finalStatus = data?.final?.status;
  const feeBps = useMemo(() => {
    const plan = (data?.memo as { tool_traces?: { name: string; result?: { fee_bps?: number } }[] } | null)?.tool_traces?.find(
      (t) => t.name === "get_plan",
    );
    return plan?.result?.fee_bps ?? DEFAULT_FEE_BPS;
  }, [data]);

  const floorNet = proposal?.premium_floor ? afterFee(Number(proposal.premium_floor) / 1e6, feeBps) : null;
  const startNet = proposal?.premium_start ? afterFee(Number(proposal.premium_start) / 1e6, feeBps) : null;
  const roundSize = proposal?.size ? Number(proposal.size) / 10 ** asset.decimals : null;
  const checkAt = proposal?.expiry ?? null;
  const prob = fillProbability(data?.memo ?? null);
  const risk = data ? riskSummary(runRiskAnswers({ memo: data.memo, verdict: null })) : null;

  const strike = Number(draft.args.targetStrike) / 1e6;
  const sizeTotal = Number(draft.args.sizeTotal) / 10 ** asset.decimals;
  const lockWhole = draft.lockIsUsdc ? Number(draft.lockAmount) / 1e6 : Number(draft.lockAmount) / 10 ** asset.decimals;
  const lockLabel = draft.lockIsUsdc ? `${fmtPrice(lockWhole)} USDC` : `${fmtSize(lockWhole)} ${asset.symbol}`;
  const buy = goal !== "sell";
  const checkText = checkAt ? dateTimeUtc(checkAt) : draft.args.quick ? "the end of each 10-minute round" : "08:00 UTC on each round's end date";
  // Interest estimate on everything set aside, until this round's check, at Jupiter Lend's MAINNET rate
  // (worker's cached reference, else the desk's lend_apy trace). Devnet Lend has no borrowers, so it pays ≈ $0.
  const deskApy = lendApy(data?.memo ?? null);
  const refApyBps = useLendReferenceApy(draft.lockIsUsdc ? "USDC" : "SOL");
  const apy = refApyBps !== null ? { bps: refApyBps } : deskApy?.source === "mainnet reference" ? { bps: deskApy.bps } : null;
  const lockedUsd = draft.lockIsUsdc ? lockWhole : spot ? lockWhole * spot : null;
  const lendYieldEst =
    apy !== null && checkAt && nowSec && lockedUsd !== null
      ? (lockedUsd * (apy.bps / 10_000) * Math.max(0, checkAt - nowSec)) / (365 * 86400)
      : null;
  const lendNote = apy ? `${(apy.bps / 100).toFixed(2)}% APY · ≈ $0 on devnet — no borrowers` : "≈ $0 on devnet — no borrowers";

  const balanceShort =
    publicKey &&
    (draft.lockIsUsdc ? usdcBal !== null && usdcBal < lockWhole : solBal !== null && solBal < lockWhole + 0.01);
  const program = useProgram();
  const client = program.status === "ready" ? program.client : null;

  const start = async () => {
    if (!publicKey) return;
    setTxError(null);
    setStage("building");
    try {
      const tx = await buildCreatePlanTx(connection, publicKey, asset, draft);
      const sig = await sendAndConfirm(connection, sendTransaction, tx, (s) => setStage(s));
      const plan = planPda(publicKey, draft.args.nonce)[0].toBase58();
      toast.success("Your plan is live", { description: `${lockLabel} moved into Jupiter Lend.` });
      router.push(`/plan/${plan}?sig=${sig}`);
    } catch (e) {
      const { message, cancelled } = explainTxError(e);
      setStage("idle");
      if (!cancelled) setTxError(message);
    }
  };

  const steps = data ? collapseSteps(data.steps) : [];
  const priced = state.status === "done" && finalStatus === "open" && floorNet !== null;
  const crash = buy ? Math.round(strike * 0.7) : Math.round(strike * 1.4);
  const lockAsset = buy ? "USDC" : asset.symbol;

  return (
    <div className="grid gap-6">
      <div>
        <Button variant="ghost" className="-ml-3 h-10 gap-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden /> Edit plan
        </Button>
        <p className="mt-3 text-sm text-muted-foreground">{sentence}</p>
        <h1 className="mt-1 font-display text-3xl leading-tight text-balance sm:text-[40px]" aria-live="polite">
          {priced ? (
            <>
              You get{" "}
              <span className="num whitespace-nowrap text-primary">
                {usd(floorNet!)}
                {startNet && startNet > floorNet! + 0.005 && <>–{usd(startNet)}</>}
              </span>{" "}
              now
            </>
          ) : state.status === "running" ? (
            "Pricing your first round…"
          ) : finalStatus === "skip" ? (
            "The desk would wait for now"
          ) : finalStatus === "vetoed" ? (
            "Risk would hold off this cycle"
          ) : (
            "Your plan is ready"
          )}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {priced
            ? `Paid upfront for round one, after Bide's ${feeBps / 100}% fee.${draft.args.quick ? " Quick-plan pricing." : ""}`
            : finalStatus === "skip" || finalStatus === "vetoed"
              ? (data?.final?.reason ?? "Your funds earn Jupiter Lend interest meanwhile.")
              : state.status === "running"
                ? "The AI desk checks live markets. About a minute."
                : "The desk prices each round when it opens."}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-4">
          {state.status === "error" && (
            <div className="flex items-start gap-3 rounded-2xl bg-warning-soft p-4 text-sm text-warning-foreground" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p className="min-w-0 flex-1">{state.message}</p>
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 rounded-full" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {state.status === "done" && data?.status === "error" && !data.final && (
            <div className="flex items-start gap-3 rounded-2xl bg-warning-soft p-4 text-sm text-warning-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p className="min-w-0 flex-1">Couldn&apos;t price this now. You can still start the plan.</p>
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 rounded-full" onClick={retry}>
                Retry
              </Button>
            </div>
          )}

          {/* Outcomes */}
          <section aria-labelledby="sc-h" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h2 id="sc-h" className="text-sm font-semibold">
              At the check{checkAt ? `, ${dateShort(checkAt)}` : ""}
            </h2>
            <dl className="mt-3 grid gap-2 text-sm">
              <div className="grid grid-cols-[5.5rem_1fr] gap-3">
                <dt className="font-semibold text-primary">It fills</dt>
                <dd>
                  {asset.symbol} {buy ? "below" : "above"} <span className="num">${fmtPrice(strike)}</span>: you {buy ? "buy" : "sell"}{" "}
                  <span className="num">{fmtSize(roundSize ?? sizeTotal)}</span> {asset.symbol} at <span className="num">${fmtPrice(strike)}</span>.
                </dd>
              </div>
              <div className="grid grid-cols-[5.5rem_1fr] gap-3">
                <dt className="font-semibold text-muted-foreground">It doesn&apos;t</dt>
                <dd>You keep your {lockAsset}. Next round starts, until {dateShort(horizonEnd)}.</dd>
              </div>
            </dl>
            <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-warning-soft p-3 text-[13px] text-warning-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="grid gap-0.5">
                <p className="font-medium">Checked once at {checkText}, not on touch.</p>
                <p>
                  If {asset.symbol} {buy ? "crashes" : "rockets"} to <span className="num">${fmtPrice(crash)}</span>, you still {buy ? "buy" : "sell"} at{" "}
                  <span className="num">${fmtPrice(strike)}</span>. You keep the pay either way.
                </p>
              </div>
            </div>
          </section>

          <PayoffSlider
            goal={goal}
            symbol={asset.symbol}
            strike={strike}
            size={roundSize ?? sizeTotal}
            lockTotal={lockWhole}
            premiumNet={floorNet}
            lendYield={lendYieldEst}
            lendNote={lendNote}
            checkAt={checkAt}
            spot={spot}
          />

          {/* Desk: collapsed by default */}
          {(steps.length > 0 || state.status === "running") && (
            <details className="group rounded-2xl border border-border bg-card">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-5 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  {state.status === "running" && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
                  {state.status === "running" ? "The AI is checking" : "See what the AI checked"}
                  {steps.length > 0 && <span className="num text-muted-foreground">({steps.length} steps)</span>}
                </span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t border-border px-4 py-4 sm:px-5">
                {steps.length > 0 ? (
                  <ol className="grid gap-2">
                    {steps.map((s, i, arr) => {
                      const last = i === arr.length - 1 && state.status === "running";
                      return (
                        <li key={s.key} className="flex items-start gap-2.5 text-sm">
                          {last ? (
                            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                          ) : (
                            <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                          )}
                          <span className={last ? "text-foreground" : "text-muted-foreground"}>{s.label}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div className="grid gap-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                )}
              </div>
            </details>
          )}
          {(data?.memoHash || risk || prob !== null) && (
            <p className="truncate text-xs text-muted-foreground">
              {[
                data?.memoHash && `memo ${data.memoHash.slice(0, 10)}…`,
                risk && `Clef ${risk}`,
                prob !== null && `~${Math.round(prob * 100)}% fill chance`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>

        {/* Commit */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="grid gap-4 rounded-2xl border border-border bg-card p-4">
            <div className="swap-panel">
              <p className="text-xs font-medium text-muted-foreground">You set aside</p>
              <p className="num mt-1 text-[26px] leading-tight font-semibold tracking-tight">{lockLabel}</p>
              <p className="mt-1 text-xs text-muted-foreground">Earns Jupiter Lend interest while it waits.</p>
            </div>
            <p className="px-1 text-[13px] text-muted-foreground">Limits enforced on-chain. Stop anytime between rounds.</p>
            {!publicKey ? (
              <WalletButton size="lg" className="h-12 w-full rounded-xl text-base" />
            ) : !client ? (
              <div className="grid gap-3">
                <Button size="lg" className="h-12 w-full rounded-xl text-base" disabled>
                  Start earning
                </Button>
                {program.status === "missing" && <p className="text-sm text-muted-foreground">{PROGRAM_NOT_READY}</p>}
              </div>
            ) : (
              <div className="grid gap-3">
                <Button size="lg" className="h-12 w-full rounded-xl text-base" onClick={start} disabled={stage !== "idle" || Boolean(balanceShort)}>
                  {stage === "idle" ? (
                    "Start earning"
                  ) : (
                    <>
                      <Loader2 className="animate-spin" aria-hidden />
                      {stage === "building" ? "Preparing…" : stage === "signing" ? "Confirm in your wallet…" : "Confirming on Solana…"}
                    </>
                  )}
                </Button>
                {balanceShort && (
                  <p className="text-sm text-destructive">
                    You have {draft.lockIsUsdc ? `${fmtPrice(usdcBal ?? 0)} USDC` : `${fmtSize(solBal ?? 0)} SOL`} — not enough for this plan.
                  </p>
                )}
              </div>
            )}
            {txError && (
              <p className="text-sm text-destructive" role="alert">
                {txError}
              </p>
            )}
            {publicKey && (
              <p className="text-xs text-muted-foreground">
                Signing as <ExplorerLink address={publicKey.toBase58()} /> on devnet.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
