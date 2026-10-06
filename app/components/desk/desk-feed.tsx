"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Bot, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ExplorerLink } from "@/components/site/bits";
import { explainError, riskSummary, runRiskAnswers } from "@/lib/desk";
import { shortAddr, timeAgo } from "@/lib/format";
import type { DeskRunRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";
import { cn } from "@/lib/utils";
import { proposalLine, RunDetail } from "./run-detail";

type Filter = "all" | "rejected" | "opened" | "held";
const WINDOW_H = 24;

/** A real rejection = the program returned an error code on a tx that landed (has a signature). */
function isOnchainRejection(r: DeskRunRow): boolean {
  return (r.status ?? "").toLowerCase() === "rejected" && !!r.error_code && !!r.tx_sig && !OFFCHAIN_CODES.has(r.error_code);
}
const OFFCHAIN_CODES = new Set(["WindowMissed", "EpochNotFound", "Transient"]);

function classify(r: DeskRunRow): { label: string; tone: "reject" | "open" | "hold" | "neutral" } {
  if (isOnchainRejection(r)) return { label: "Rejected on-chain", tone: "reject" };
  if (r.error_code === "WindowMissed") return { label: "Missed window", tone: "hold" };
  if (r.error_code === "EpochNotFound") return { label: "Skipped (no epoch)", tone: "hold" };
  if (r.error_code === "Transient" || (r.status ?? "").toLowerCase() === "submit_failed") return { label: "Skipped (send failed)", tone: "hold" };
  if (r.error_code === "WorkerRestart") return { label: "Interrupted (restart)", tone: "hold" };
  if (r.error_code) return { label: "Not sent", tone: "hold" };
  const s = (r.final?.status ?? r.status ?? "").toLowerCase();
  if (r.tx_sig && s === "open") return { label: "Round opened", tone: "open" };
  if (s === "open") return { label: r.kind === "preview" ? "Preview" : "Proposed", tone: "neutral" };
  if (s === "skip") return { label: "Skipped", tone: "hold" };
  if (s === "vetoed") return { label: "Vetoed by Risk", tone: "hold" };
  if (s === "flip") return { label: "Flip to sell", tone: "open" };
  if (s === "stop") return { label: "Stopped", tone: "hold" };
  if (s === "error") return { label: "Desk error", tone: "hold" };
  return { label: s || "Running", tone: "neutral" };
}

export function DeskFeed() {
  const [filter, setFilter] = useState<Filter>("all");
  const runs = useTable<DeskRunRow>({ table: "desk_runs", orderBy: "created_at", ascending: false, limit: 300, pollMs: 10_000 });
  const rows = useMemo(() => (runs.status === "ready" ? runs.rows : []), [runs]);

  const rejections = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- relative window, recomputed with each data refresh
    const since = Date.now() - WINDOW_H * 3600_000;
    return rows.filter((r) => isOnchainRejection(r) && Date.parse(r.created_at) >= since).length;
  }, [rows]);

  const shown = rows.filter((r) => {
    const c = classify(r).tone;
    if (filter === "rejected") return c === "reject";
    if (filter === "opened") return c === "open";
    if (filter === "held") return c === "hold";
    return true;
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-[1.4fr_1fr]">
        <div className="bg-card p-4 sm:p-5">
          <p className="text-xs font-medium text-muted-foreground">Real on-chain rejections</p>
          <p className={cn("num mt-1.5 text-4xl leading-none font-semibold tracking-tight", runs.status === "ready" && rejections > 0 && "text-destructive")}>
            {runs.status === "ready" ? rejections : "—"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            in the last {WINDOW_H} h. The AI is allowed to try; the Solana program decides. The prompt doesn&apos;t forbid out-of-bounds
            proposals and Risk is given no plan bounds directly. Only landed transactions the program rejected count here; missed windows and skipped sends are listed separately.
          </p>
        </div>
        <div className="grid content-center gap-2 bg-card p-4 text-[13px] sm:p-5">
          <p className="flex items-center gap-2">
            <Bot className="size-4 text-primary" aria-hidden /> Quant (GLM) proposes each round
          </p>
          <p className="flex items-center gap-2">
            <Bot className="size-4 text-primary" aria-hidden /> Risk (Clef) scores it with probabilities
          </p>
          <p className="flex items-center gap-2">
            <ShieldX className="size-4 text-primary" aria-hidden /> The program accepts or rejects it
          </p>
        </div>
      </div>

      <div role="tablist" aria-label="Filter desk runs" className="flex w-fit max-w-full flex-wrap gap-1 rounded-full border border-border bg-card p-1">
        {(
          [
            ["all", "All"],
            ["rejected", "Rejected"],
            ["opened", "Opened"],
            ["held", "Skipped / vetoed"],
          ] as [Filter, string][]
        ).map(([id, label]) => (
          <Button
            key={id}
            role="tab"
            aria-selected={filter === id}
            variant="ghost"
            className={cn("h-9 rounded-full px-3.5 text-[13px]", filter === id ? "bg-secondary text-primary hover:bg-secondary hover:text-primary" : "text-muted-foreground")}
            onClick={() => setFilter(id)}
          >
            {label}
          </Button>
        ))}
      </div>

      {runs.status === "unconfigured" ? (
        <EmptyState title="Data feed not configured">The desk writes every run to the data feed. Connect it to see the live history.</EmptyState>
      ) : runs.status === "loading" ? (
        <div className="grid gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : runs.status === "error" ? (
        <EmptyState title="Couldn't load the desk feed" action={<Button variant="outline" onClick={runs.reload}>Try again</Button>}>
          {runs.message}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title={filter === "all" ? "No desk runs yet" : "Nothing in this filter yet"}>
          The desk runs whenever a plan is inside an auction window. New runs appear here live.
        </EmptyState>
      ) : (
        <ol className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {shown.map((r) => {
            const c = classify(r);
            const risk = riskSummary(runRiskAnswers(r));
            const prop = proposalLine((r.final?.proposal ?? r.proposal) as Record<string, unknown> | null);
            const retry = Boolean((r.memo as { inputs?: { chain_retry?: unknown } } | null)?.inputs?.chain_retry);
            return (
              <li
                key={r.id}
                className={cn(
                  "grid gap-3 px-4 py-3.5 animate-in fade-in-0 duration-300 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5",
                  c.tone === "reject" && "border-l-2 border-l-destructive",
                )}
              >
                <div className="grid min-w-0 gap-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge
                      variant={c.tone === "reject" ? "destructive" : c.tone === "open" ? "default" : "secondary"}
                      className="rounded-full"
                    >
                      {c.label}
                    </Badge>
                    {retry && <Badge variant="outline">Retry after rejection</Badge>}
                    {(r.memo as { outcomes_cited?: boolean | null } | null)?.outcomes_cited === true && (
                      <Badge variant="outline">Cites track record</Badge>
                    )}
                    <span className="text-muted-foreground">{timeAgo(r.created_at)}</span>
                    {r.plan_pubkey && (
                      <Link href={`/plan/${r.plan_pubkey}`} className="font-mono text-[11px] text-muted-foreground hover:text-foreground">
                        plan {shortAddr(r.plan_pubkey)}
                      </Link>
                    )}
                  </div>
                  {r.error_code && (
                    <p className="text-[13px]">
                      <span className="font-mono text-xs text-destructive">{r.error_code}</span>
                      {explainError(r.error_code) && <span className="text-muted-foreground"> — {explainError(r.error_code)}</span>}
                    </p>
                  )}
                  {prop && <p className="num truncate text-xs text-muted-foreground">{prop}</p>}
                  {!r.error_code && r.final?.reason && <p className="line-clamp-2 text-[13px] text-muted-foreground">{r.final.reason}</p>}
                  {risk && <p className="text-xs text-muted-foreground">Risk: {risk}</p>}
                </div>
                <div className="flex items-center gap-3">
                  {r.tx_sig && <ExplorerLink sig={r.tx_sig}>Transaction</ExplorerLink>}
                  <RunDetail
                    run={r}
                    trigger={
                      <Button variant="secondary" className="h-9 rounded-full">
                        Why?
                      </Button>
                    }
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
