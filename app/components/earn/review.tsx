"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AlertTriangle, ArrowLeft, Check, CircleDashed, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_FEE_BPS, USDC_MINT, type AssetInfo } from "@/lib/constants";
import { PROGRAM_NOT_READY } from "@/lib/bide-client";
import { fillProbability, lendApyBps, riskSummary, runRiskAnswers, stepLabel } from "@/lib/desk";
import { dateShort, dateTimeUtc, usd } from "@/lib/format";
import { afterFee, fmtPrice, fmtSize, type Draft, type Goal } from "@/lib/plan-math";
import { planPda } from "@bide/shared";
import { sendAndConfirm } from "@/lib/send";
import { buildCreatePlanTx, explainTxError } from "@/lib/tx";
import type { Patience } from "@/lib/types";
import { useDeskPreview } from "@/hooks/use-desk-preview";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { useNow } from "@/hooks/use-now";
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
  const { state, run } = useDeskPreview();
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
  const apyBps = lendApyBps(data?.memo ?? null);
  const risk = data ? riskSummary(runRiskAnswers({ memo: data.memo, verdict: null })) : null;

  const strike = Number(draft.args.targetStrike) / 1e6;
  const sizeTotal = Number(draft.args.sizeTotal) / 10 ** asset.decimals;
  const lockWhole = draft.lockIsUsdc ? Number(draft.lockAmount) / 1e6 : Number(draft.lockAmount) / 10 ** asset.decimals;
  const lockLabel = draft.lockIsUsdc ? `${fmtPrice(lockWhole)} USDC` : `${fmtSize(lockWhole)} ${asset.symbol}`;
  const buy = goal !== "sell";
  const checkText = checkAt ? dateTimeUtc(checkAt) : draft.args.quick ? "the end of each 10-minute round" : "08:00 UTC on each round's end date";
  // Interest estimate for this round only, from the desk's lend_apy tool (null if unknown).
  const lockedUsd = draft.lockIsUsdc ? lockWhole : spot ? lockWhole * spot : null;
  const lendYieldEst =
    apyBps !== null && checkAt && nowSec && lockedUsd !== null
      ? (lockedUsd * (apyBps / 10_000) * Math.max(0, checkAt - nowSec)) / (365 * 86400)
      : null;

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

  return (
    <div className="grid gap-6">
      <div>
        <Button variant="ghost" className="-ml-3 h-10 gap-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden /> Edit plan
        </Button>
        <p className="mt-3 text-xs font-medium text-primary">Review</p>
        <h1 className="mt-1 font-display text-2xl leading-tight text-balance sm:text-[28px]">{sentence}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          If it hasn&apos;t filled by {dateShort(horizonEnd)}, your {buy ? "USDC" : asset.symbol} comes back automatically with everything
          you earned.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-4">
          {/* Desk */}
          <section aria-labelledby="desk-h" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-4">
              <h2 id="desk-h" className="text-sm font-semibold">
                {state.status === "running" ? "The desk is pricing your first round…" : "What the desk would do first"}
              </h2>
              {data?.memoHash && <span className="truncate font-mono text-[11px] text-muted-foreground">memo {data.memoHash.slice(0, 10)}…</span>}
            </div>
            {state.status === "error" && (
              <div className="mt-4 flex items-start gap-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>{state.message}</p>
              </div>
            )}
            {data && data.steps.length > 0 && (
              <ol className="mt-4 grid gap-2" aria-live="polite">
                {data.steps
                  .filter((s) => s.step !== "start")
                  .map((s, i, arr) => {
                    const last = i === arr.length - 1 && state.status === "running";
                    return (
                      <li key={`${s.step}-${i}`} className="flex items-start gap-2.5 text-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
                        {last ? (
                          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                        ) : (
                          <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        )}
                        <span className={last ? "text-foreground" : "text-muted-foreground"}>{stepLabel(s)}</span>
                      </li>
                    );
                  })}
              </ol>
            )}
            {state.status === "running" && (!data || data.steps.length === 0) && (
              <div className="mt-4 grid gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            )}
            {state.status === "done" && data?.status === "error" && !data.final && (
              <div className="mt-4 flex items-start gap-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>The desk couldn&apos;t price this right now. You can still start the plan — the desk prices each round when it opens.</p>
              </div>
            )}
            {state.status === "done" && data?.final && (
              <div className="mt-4 grid gap-3 border-t border-border pt-4">
                {finalStatus === "open" && floorNet !== null ? (
                  <>
                    <p className="text-xl leading-snug font-semibold tracking-tight">
                      You&apos;d get <span className="num font-medium text-primary">{usd(floorNet)}</span>
                      {startNet && startNet > floorNet + 0.005 && (
                        <>
                          {" "}
                          to <span className="num font-medium text-primary">{usd(startNet)}</span>
                        </>
                      )}{" "}
                      upfront for the first round.
                    </p>
                    <ul className="grid gap-1 text-[13px] text-muted-foreground">
                      {roundSize !== null && (
                        <li>
                          First round: {fmtSize(roundSize)} {asset.symbol}
                          {roundSize < sizeTotal ? ` of ${fmtSize(sizeTotal)} (the desk ladders into your goal)` : ""}, checked {checkText}.
                        </li>
                      )}
                      {prob !== null && <li>Chance this round fills: about {Math.round(prob * 100)}% (from exchange option prices).</li>}
                      {risk && <li>Risk check: {risk}.</li>}
                      <li>All figures are after Bide&apos;s {feeBps / 100}% fee. The final amount is set by the auction.</li>
                      {draft.args.quick && <li>Quick-plan pricing: priced with the nearest listed exchange option.</li>}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {finalStatus === "skip"
                      ? `The desk would wait for now: ${data?.final?.reason ?? "conditions aren't good enough yet"}. Your funds earn Jupiter Lend interest until the next window.`
                      : finalStatus === "vetoed"
                        ? `Risk would hold off this cycle: ${data?.final?.reason ?? ""}. Your funds wait in Jupiter Lend.`
                        : data?.final?.reason ?? "No round proposed right now."}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Scenarios */}
          <section aria-labelledby="sc-h" className="grid gap-3">
            <h2 id="sc-h" className="text-sm font-semibold">
              What can happen{checkAt ? ` on ${dateShort(checkAt)}` : " each round"}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-border bg-card p-4">
                <p className="text-xs font-semibold text-primary">It fills</p>
                <p className="mt-1.5 text-sm leading-relaxed">
                  If {asset.symbol} is {buy ? "below" : "above"} <span className="num">${fmtPrice(strike)}</span> at the check, you{" "}
                  {buy ? "buy" : "sell"} {fmtSize(roundSize ?? sizeTotal)} {asset.symbol} at exactly{" "}
                  <span className="num">${fmtPrice(strike)}</span>. You keep {floorNet !== null ? usd(floorNet) : "what you were paid"}.
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <p className="text-xs font-semibold text-muted-foreground">It doesn&apos;t fill</p>
                <p className="mt-1.5 text-sm leading-relaxed">
                  Otherwise you keep your {buy ? "USDC" : asset.symbol}, keep {floorNet !== null ? usd(floorNet) : "what you were paid"}, and earn
                  Jupiter Lend interest. Then the next round starts automatically — you can stop anytime between rounds.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-warning-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="grid gap-1.5 text-[13px] leading-relaxed">
                <p className="font-medium">Checked once, at {checkText} — not the moment the price touches ${fmtPrice(strike)}.</p>
                {buy ? (
                  <p>
                    If {asset.symbol} dips to ${fmtPrice(Math.round(strike * 0.95))} mid-round and is back at ${fmtPrice(Math.round(strike * 1.05))} at the check, you
                    don&apos;t buy (you keep what you were paid). If {asset.symbol} crashes to ${fmtPrice(Math.round(strike * 0.7))}, you still buy at $
                    {fmtPrice(strike)}.
                  </p>
                ) : (
                  <p>
                    If {asset.symbol} spikes to ${fmtPrice(Math.round(strike * 1.05))} mid-round and is back at ${fmtPrice(Math.round(strike * 0.95))} at the check, you
                    don&apos;t sell. If {asset.symbol} rockets to ${fmtPrice(Math.round(strike * 1.4))}, you still sell at ${fmtPrice(strike)}.
                  </p>
                )}
                <p>Same price as a limit order, different trigger.</p>
              </div>
            </div>
          </section>

          <PayoffSlider
            goal={goal}
            symbol={asset.symbol}
            strike={strike}
            size={roundSize ?? sizeTotal}
            premiumNet={floorNet}
            lendYield={lendYieldEst}
            checkAt={checkAt}
            spot={spot}
          />
        </div>

        {/* Commit */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="grid gap-4 rounded-2xl border border-border bg-card p-4">
            <div className="swap-panel">
              <p className="text-xs font-medium text-muted-foreground">You set aside</p>
              <p className="num mt-1 text-[26px] leading-tight font-semibold tracking-tight">{lockLabel}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Goes into Jupiter Lend and earns interest. {goal === "sell" ? "Your SOL is wrapped automatically in the same signature." : ""}
              </p>
            </div>
            <ul className="grid gap-2 px-1 text-[13px]">
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                Your price, deadline and minimum pay are enforced by the Solana program.
              </li>
              <li className="flex gap-2">
                <CircleDashed className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                One signature. Stop anytime between rounds.
              </li>
            </ul>
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
