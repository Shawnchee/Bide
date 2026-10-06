"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Loader2, Pause, Play, Sparkles, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Addr, EmptyState, ExplorerLink, Stat } from "@/components/site/bits";
import { RunDetail } from "@/components/desk/run-detail";
import { DEFAULT_FEE_BPS } from "@/lib/constants";
import { PROGRAM_NOT_READY, type DecodedPlan } from "@/lib/bide-client";
import { dateShort, dateTimeUtc, duration, fromBase, toBig, toUnix, usd, usdc, usdcPrice } from "@/lib/format";
import { LEND_EXCHANGE_PRICE_PRECISION, LEND_MARKETS, LENDING_TOKEN_EXCHANGE_PRICE_OFFSET } from "@bide/shared";
import { fmtPrice, fmtSize } from "@/lib/plan-math";
import { sendAndConfirm } from "@/lib/send";
import { buildClosePlanTx, buildPausePlanTx, explainTxError } from "@/lib/tx";
import type { DeskRunRow, EpochRow, MakerBidRow, PlanRow, RoundRow } from "@/lib/types";
import { MakerBidList } from "@/components/agents/maker-bids";
import { useTable } from "@/hooks/use-table";
import { useNow } from "@/hooks/use-now";
import { useStatus } from "@/hooks/use-status";
import { useProgram } from "@/hooks/use-program";
import { cn } from "@/lib/utils";

const STAGES = ["Auction", "Live", "Sampling", "Resolved"] as const;
type Stage = (typeof STAGES)[number];

/** Sampling window length per epoch kind (BUILD §3.2: std 10×180 s, quick 10×10 s). */
const samplingSecs = (quick: boolean) => (quick ? 100 : 1800);

function roundStage(r: RoundRow, epoch: EpochRow | undefined, now: number, quick: boolean): Stage {
  const st = String(r.status).toLowerCase();
  if (st === "auction") return "Auction";
  if (["resolved", "settled", "unwound", "cancelled"].includes(st)) return "Resolved";
  const expiry = toUnix(r.expiry) ?? 0;
  if (epoch && String(epoch.status).toLowerCase() === "sampling") return "Sampling";
  if (now >= expiry - samplingSecs(quick)) return "Sampling";
  return "Live";
}

const netPremium = (r: RoundRow) => {
  const gross = toBig(r.premium_paid);
  if (gross === null) return null;
  const fee = toBig(r.fee_paid) ?? (gross * BigInt(DEFAULT_FEE_BPS)) / 10_000n;
  return gross - fee;
};

function Timeline({ stage, round }: { stage: Stage | null; round: RoundRow | null }) {
  const idx = stage ? STAGES.indexOf(stage) : -1;
  const outcome = round ? String(round.status).toLowerCase() : "";
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Round progress">
      {STAGES.map((s, i) => {
        const done = i < idx || (i === idx && s === "Resolved");
        const current = i === idx && s !== "Resolved";
        return (
          <li key={s} className="grid gap-2" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "h-1 rounded-full transition-colors duration-500",
                done ? "bg-primary" : current ? "bg-primary/50" : "bg-secondary",
              )}
            />
            <span className={cn("text-xs font-medium", current || done ? "text-foreground" : "text-muted-foreground")}>
              {s === "Resolved" && outcome === "unwound" ? "Unwound" : s === "Resolved" && outcome === "cancelled" ? "No taker" : s}
              {current && <span className="sr-only"> (now)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Samples({ epoch }: { epoch: EpochRow | undefined }) {
  const raw = epoch?.samples ?? [];
  const n = 10;
  const prices: (number | null)[] = Array.from({ length: n }, (_, i) => {
    const v = (raw as unknown[])[i];
    if (v === null || v === undefined) return null;
    if (typeof v === "object" && v && "price" in v) return fromBase((v as { price: string }).price, 6);
    const p = fromBase(v as string, 6);
    return p && p > 0 ? p : null;
  });
  const filled = prices.filter((p) => p !== null).length;
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium text-muted-foreground">Pyth price checks</p>
        <p className="num text-xs text-muted-foreground">
          {filled}/{n}
        </p>
      </div>
      <ol className="grid grid-cols-5 gap-2 sm:grid-cols-10">
        {prices.map((p, i) => (
          <li
            key={i}
            className={cn(
              "flex h-11 flex-col items-center justify-center rounded-lg border text-[11px] transition-colors duration-300",
              p !== null ? "border-primary/40 bg-accent text-accent-foreground" : "border-dashed border-border text-muted-foreground",
            )}
          >
            <span className="text-[10px] opacity-70">#{i + 1}</span>
            <span className="num">{p !== null ? `$${fmtPrice(p)}` : "—"}</span>
          </li>
        ))}
      </ol>
      {epoch?.settle_price && (
        <p className="text-sm">
          Settlement price (median): <span className="num font-medium">{usdc(epoch.settle_price)}</span>
        </p>
      )}
    </div>
  );
}

export function PlanView({ id, createSig }: { id: string; createSig: string | null }) {
  const now = useNow();
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { dataConfigured } = useStatus();
  const program = useProgram();
  const client = program.status === "ready" ? program.client : null;
  const [chainPlan, setChainPlan] = useState<DecodedPlan | null | "missing" | "loading">("loading");
  const [busy, setBusy] = useState<null | "pause" | "close">(null);
  const [tick, setTick] = useState(0);

  const plans = useTable<PlanRow>({ table: "plans", eq: [["plan_pubkey", id]], limit: 1, realtimeFilter: `plan_pubkey=eq.${id}` });
  const rounds = useTable<RoundRow>({
    table: "rounds",
    eq: [["plan_pubkey", id]],
    orderBy: "expiry",
    ascending: false,
    limit: 50,
    realtimeFilter: `plan_pubkey=eq.${id}`,
    pollMs: 8000,
  });
  const runs = useTable<DeskRunRow>({
    table: "desk_runs",
    eq: [["plan_pubkey", id]],
    orderBy: "created_at",
    ascending: false,
    limit: 20,
    realtimeFilter: `plan_pubkey=eq.${id}`,
  });
  const roundRows = useMemo(() => (rounds.status === "ready" ? rounds.rows : []), [rounds]);
  const latest = roundRows[0] ?? null;
  const latestBids = useTable<MakerBidRow>({
    table: "maker_bids",
    eq: [["round_pubkey", latest?.round_pubkey ?? ""]],
    limit: 10,
    enabled: Boolean(latest),
    realtimeFilter: latest ? `round_pubkey=eq.${latest.round_pubkey}` : undefined,
    pollMs: 8000,
  });
  const epochs = useTable<EpochRow>({
    table: "epochs",
    // rounds mirror has no epoch link; epochs are unique per (asset, kind, expiry) — expiry is timestamptz.
    eq: [["expiry", latest ? new Date((toUnix(latest.expiry) ?? 0) * 1000).toISOString() : ""]],
    limit: 4,
    enabled: Boolean(latest),
    pollMs: 5000,
  });

  // On-chain read (exists + decoded state when the program interface is published).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pk = new PublicKey(id);
        if (client) {
          const p = await client.fetchPlan(connection, pk);
          if (alive) setChainPlan(p ?? "missing");
        } else {
          const info = await connection.getAccountInfo(pk);
          if (alive) setChainPlan(info ? null : "missing");
        }
      } catch {
        if (alive) setChainPlan(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, connection, client, busy, tick]);

  // A freshly created plan can take a few seconds to be readable; keep checking.
  useEffect(() => {
    if (chainPlan !== "missing") return;
    const t = setInterval(() => setTick((x) => x + 1), 4000);
    return () => clearInterval(t);
  }, [chainPlan]);

  // Lend interest = value of the plan's fTokens − principal. Exchange price read from the Lend
  // `Lending` account (1e12 precision, refreshes on each Lend interaction — slightly conservative).
  const [lendYield, setLendYield] = useState<{ amount: number; unit: string } | null>(null);
  useEffect(() => {
    const dp = chainPlan && typeof chainPlan === "object" ? chainPlan : null;
    if (!dp || dp.lendShares === 0n) return;
    const usdcSide = dp.side === "buy" || (dp.side === "wheel" && dp.phase === "accumulate");
    const market = usdcSide ? LEND_MARKETS.USDC : LEND_MARKETS.WSOL;
    let alive = true;
    connection.getAccountInfo(market.lending).then((info) => {
      if (!alive || !info) return;
      const price = new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(LENDING_TOKEN_EXCHANGE_PRICE_OFFSET, true);
      const value = (dp.lendShares * price) / LEND_EXCHANGE_PRICE_PRECISION;
      const earned = value > dp.collateralPrincipal ? value - dp.collateralPrincipal : 0n;
      setLendYield(usdcSide ? { amount: Number(earned) / 1e6, unit: "USDC" } : { amount: Number(earned) / 1e9, unit: "SOL" });
    });
    return () => {
      alive = false;
    };
  }, [chainPlan, connection]);

  const plan = plans.status === "ready" ? plans.rows[0] : undefined;
  const decoded = chainPlan && typeof chainPlan === "object" ? chainPlan : null;
  const quick = decoded?.quick ?? plan?.quick ?? false;
  const epochRows = epochs.status === "ready" ? epochs.rows : [];
  const epoch = latest
    ? epochRows.find((e) => e.epoch_pubkey === latest.epoch_pubkey) ??
      epochRows.find((e) => String(e.kind).toLowerCase() === (quick ? "quick" : "std"))
    : undefined;
  const stage = latest ? roundStage(latest, epoch, now, quick) : null;

  const earned = useMemo(() => roundRows.reduce((acc, r) => acc + (netPremium(r) ?? 0n), 0n), [roundRows]);
  const side = String(decoded?.side ?? plan?.side ?? "").toLowerCase();
  const buy = side !== "sell";
  // Sell plans keep their price in exit_strike (target_strike is 0 for them).
  const strikeOf = (t: unknown, x: unknown) => (buy ? t : x);
  const target = decoded
    ? Number(strikeOf(decoded.targetStrike, decoded.exitStrike) ?? 0) / 1e6
    : plan ? fromBase(strikeOf(plan.target_strike, plan.exit_strike) as never, 6) : null;
  const sizeTotal = decoded ? Number(decoded.sizeTotal) / 1e9 : plan ? fromBase(plan.size_total, 9) : null;
  const sizeFilled = decoded ? Number(decoded.sizeFilled) / 1e9 : plan ? fromBase(plan.size_filled, 9) : null;
  const horizon = decoded?.horizonEnd ?? toUnix(plan?.horizon_end ?? null);
  const owner = decoded?.owner ?? plan?.owner ?? null;
  const isOwner = Boolean(publicKey && owner && publicKey.toBase58() === owner);
  const paused = decoded?.paused ?? plan?.paused ?? false;
  const status = String(decoded?.status ?? plan?.status ?? "").toLowerCase();
  const latestExpiry = latest ? toUnix(latest.expiry) : null;
  const latestRun = runs.status === "ready" ? runs.rows.find((r) => r.kind === "round") ?? runs.rows[0] : undefined;

  const act = async (kind: "pause" | "close") => {
    if (!publicKey) return;
    setBusy(kind);
    try {
      const pk = new PublicKey(id);
      const tx = kind === "pause" ? await buildPausePlanTx(connection, publicKey, pk, !paused) : await buildClosePlanTx(connection, publicKey, pk);
      const sig = await sendAndConfirm(connection, sendTransaction, tx);
      toast.success(kind === "close" ? "Plan closed — funds returned" : paused ? "Plan resumed" : "Plan paused", {
        action: { label: "View", onClick: () => window.open(`https://explorer.solana.com/tx/${sig}?cluster=devnet`, "_blank") },
      });
      plans.reload();
    } catch (e) {
      const { message, cancelled } = explainTxError(e);
      if (!cancelled) toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const loading = plans.status === "loading" && chainPlan === "loading";
  const notFound = chainPlan === "missing" && (plans.status !== "ready" || !plan);

  if (loading) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {side && (
              <p className="text-xs font-medium text-primary">{side === "wheel" ? "Buy, then sell" : buy ? "Buy plan" : "Sell plan"}</p>
            )}
            {quick && <Badge variant="secondary">Quick plan</Badge>}
            {paused && <Badge variant="outline">Paused</Badge>}
            {status && status !== "active" && <Badge variant="outline">{status}</Badge>}
          </div>
          <h1 className="mt-1 font-display text-2xl leading-tight text-balance sm:text-[28px]">
            {target && sizeTotal
              ? `${buy ? "Buy" : "Sell"} ${fmtSize(sizeTotal)} SOL at $${fmtPrice(target)}${horizon ? `, until ${dateShort(horizon)}` : ""}`
              : "Your plan"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              Plan <Addr value={id} />
            </span>
            <ExplorerLink address={id}>Explorer</ExplorerLink>
            {createSig && <ExplorerLink sig={createSig}>Creation transaction</ExplorerLink>}
          </div>
        </div>
        {isOwner && (
          <div className="flex gap-2">
            <Button variant="secondary" className="h-10 rounded-full" disabled={!client || busy !== null || status !== "active"} onClick={() => act("pause")}>
              {busy === "pause" ? <Loader2 className="animate-spin" aria-hidden /> : paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="secondary"
              className="h-10 rounded-full"
              disabled={!client || busy !== null || status !== "active" || Boolean(latest && ["auction", "live"].includes(String(latest.status).toLowerCase()))}
              onClick={() => act("close")}
            >
              {busy === "close" ? <Loader2 className="animate-spin" aria-hidden /> : <XCircle aria-hidden />}
              Close &amp; withdraw
            </Button>
          </div>
        )}
      </div>
      {isOwner && program.status === "missing" && <p className="-mt-3 text-xs text-muted-foreground">{PROGRAM_NOT_READY}</p>}

      {notFound && (
        <EmptyState title="Plan not found on devnet yet">
          {createSig ? "Can take a few seconds. Still checking." : "Check the address, or start a new plan."}
        </EmptyState>
      )}
      {!notFound && (
      <>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-4">
        <div className="bg-card p-4">
          <Stat label="Earned so far" value={roundRows.length ? usdc(earned) : "—"} sub="after Bide's fee" />
        </div>
        <div className="bg-card p-4">
          <Stat
            label="Lend interest"
            value={lendYield ? (lendYield.unit === "USDC" ? usd(lendYield.amount) : `${lendYield.amount.toFixed(6)} SOL`) : "—"}
            sub="Jupiter Lend, on-chain"
          />
        </div>
        <div className="bg-card p-4">
          <Stat
            label="Progress"
            value={sizeTotal ? `${fmtSize(sizeFilled ?? 0)} / ${fmtSize(sizeTotal)} SOL` : "—"}
            sub={<Progress value={sizeTotal ? ((sizeFilled ?? 0) / sizeTotal) * 100 : 0} className="mt-1 h-1" aria-label="Filled" />}
          />
        </div>
        <div className="bg-card p-4">
          <Stat
            label={latestExpiry && latestExpiry > now ? "This round ends in" : "Plan ends in"}
            value={
              now === 0
                ? "—"
                : latestExpiry && latestExpiry > now
                  ? duration(latestExpiry - now)
                  : horizon && horizon > now
                    ? duration(horizon - now)
                    : horizon
                      ? "ended"
                      : "—"
            }
            sub={latestExpiry && latestExpiry > now ? dateTimeUtc(latestExpiry) : horizon ? dateTimeUtc(horizon) : undefined}
          />
        </div>
      </div>

      <section aria-labelledby="round-h" className="grid gap-5 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="round-h" className="text-sm font-semibold">
            {latest ? "Current round" : "Waiting for the first round"}
          </h2>
          {latestRun && (
            <RunDetail
              run={latestRun}
              onChainMemoHash={latest?.memo_hash}
              trigger={
                <Button variant="soft" className="h-9 gap-2 rounded-full">
                  <Sparkles className="size-4" aria-hidden /> Why this?
                </Button>
              }
            />
          )}
        </div>
        {!dataConfigured ? (
          <p className="text-sm text-muted-foreground">Round status appears once the data feed connects.</p>
        ) : rounds.status === "loading" ? (
          <Skeleton className="h-16 w-full" />
        ) : rounds.status === "error" ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load rounds: {rounds.message}{" "}
            <button className="underline" onClick={rounds.reload}>
              Retry
            </button>
          </p>
        ) : !latest ? (
          <p className="text-sm text-muted-foreground">
            {quick
              ? "Earning Jupiter Lend interest. Next round opens within 10 minutes."
              : "Earning Jupiter Lend interest. Rounds open daily, 08:00–08:30 UTC."}
          </p>
        ) : (
          <>
            <Timeline stage={stage} round={latest} />
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border text-[13px] sm:grid-cols-4 [&>div]:bg-secondary/60 [&>div]:p-3 [&_dt]:text-xs [&_dd]:font-medium">
              <div>
                <dt className="text-muted-foreground">Price</dt>
                <dd className="num mt-0.5">{usdcPrice(latest.strike)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Size</dt>
                <dd className="num mt-0.5">{fmtSize(fromBase(latest.size, 9) ?? 0)} SOL</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Paid to you</dt>
                <dd className="num mt-0.5">{netPremium(latest) !== null ? usdc(netPremium(latest)) : stage === "Auction" ? "auction running" : "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Taken by</dt>
                <dd className="mt-0.5">{latest.is_pool ? "Backstop pool" : latest.maker ? <Addr value={latest.maker} /> : "—"}</dd>
              </div>
            </dl>
            {latestBids.status === "ready" && latestBids.rows.length > 0 && (
              <div className="grid gap-2">
                <p className="text-xs font-medium text-muted-foreground">Maker bids</p>
                <MakerBidList bids={latestBids.rows} roundMaker={latest.maker} />
              </div>
            )}
            {(stage === "Sampling" || stage === "Resolved") && <Samples epoch={epoch} />}
            {stage === "Resolved" && latest.exercised !== null && (
              <p className="rounded-xl border border-primary/25 bg-accent p-4 text-sm text-accent-foreground">
                {latest.exercised === 2 || latest.exercised === true
                  ? buy
                    ? `Filled: bought ${fmtSize(fromBase(latest.size, 9) ?? 0)} SOL at ${usdcPrice(latest.strike)}. You kept the pay.`
                    : `Filled: sold at ${usdcPrice(latest.strike)}. You kept the pay.`
                  : `Not filled: you kept your ${buy ? "USDC" : "SOL"} and the pay. Next round starts automatically.`}
              </p>
            )}
            {latest.sigs && Object.keys(latest.sigs).length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {Object.entries(latest.sigs).map(([k, s]) => (
                  <ExplorerLink key={k} sig={s}>
                    {k.replace(/_/g, " ")}
                  </ExplorerLink>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {roundRows.length > 1 && (
        <section aria-labelledby="hist-h" className="overflow-hidden rounded-2xl border border-border bg-card">
          <h2 id="hist-h" className="px-4 pt-4 pb-2 text-sm font-semibold sm:px-5">
            Past rounds
          </h2>
          <div className="overflow-x-auto">
            <table className="data-table min-w-[32rem]">
              <thead>
                <tr>
                  <th scope="col" className="sm:pl-5">Checked</th>
                  <th scope="col" className="text-right">Price</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right sm:pr-5">Paid to you</th>
                </tr>
              </thead>
              <tbody>
                {roundRows.slice(1).map((r) => (
                  <tr key={r.round_pubkey}>
                    <td className="num text-muted-foreground sm:pl-5">{dateTimeUtc(toUnix(r.expiry))}</td>
                    <td className="num text-right">{usdcPrice(r.strike)}</td>
                    <td className="capitalize">{String(r.status)}</td>
                    <td className="num text-right font-medium text-positive sm:pr-5">{netPremium(r) !== null ? `+${usdc(netPremium(r))}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      </>
      )}
    </div>
  );
}
