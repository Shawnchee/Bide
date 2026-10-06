"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ExplorerLink } from "@/components/site/bits";
import { explainError } from "@/lib/desk";
import { shortAddr, timeAgo, usdcPrice } from "@/lib/format";
import { fmtSize } from "@/lib/plan-math";
import type { DeskRunRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";
import { cn } from "@/lib/utils";
import { RunDetail } from "./run-detail";

type Filter = "all" | "rejected" | "opened" | "held";
type Tone = "reject" | "open" | "hold" | "neutral";
const WINDOW_H = 24;
const PAGE = 25;

/** A real rejection = the program returned an error code on a tx that landed (has a signature). */
function isOnchainRejection(r: DeskRunRow): boolean {
  return (r.status ?? "").toLowerCase() === "rejected" && !!r.error_code && !!r.tx_sig && !OFFCHAIN_CODES.has(r.error_code);
}
const OFFCHAIN_CODES = new Set(["WindowMissed", "EpochNotFound", "Transient"]);

/** Plain wording for the program's error codes (falls back to lib/desk's explainError). */
const PLAIN_ERROR: Record<string, string> = {
  OutsideAuctionWindow: "It arrived after the round's start time.",
  AuctionParamsInvalid: "Its asking prices didn't add up.",
  StrikeOffTick: "Its price wasn't a whole allowed step.",
};

function plainError(code: string): string {
  for (const [k, v] of Object.entries(PLAIN_ERROR)) if (code.includes(k)) return v;
  const e = explainError(code);
  return e ? `${e.replace(/the user's/gi, "your")}.` : "A Solana rule blocked it.";
}

/** "Waited" reasons, read from the AI's own rationale (pay too low vs price too far). */
function waitReason(rationale: string): string {
  if (/user.?min|minimum|premium.?(start|floor)[^.]{0,40}\b0\b|zero premium|essentially zero|premium of 0/i.test(rationale))
    return "Pay was too low — below your minimum.";
  if (/venue|pricer error|max.?expiry|week/i.test(rationale)) return "Your price is too far away to price fairly now.";
  return "Pay too low or price too far this round.";
}

function vetoReason(reason: string): string {
  const r = reason.replace(/^risk vetoed:\s*/i, "");
  if (/rationale does not match/i.test(r)) return "The AI's reasons didn't match its own numbers.";
  if (/too aggressive/i.test(r)) return "Too bold for your patience setting.";
  const first = r.split(/(?<=\.)\s/)[0] ?? r;
  return first.replace(/rationale/gi, "reasoning");
}

/** Decision in plain words + one plain sentence why. */
function describe(r: DeskRunRow): {
  label: string;
  reason: string;
  tone: Tone;
} {
  const prop = (r.final?.proposal ?? r.proposal) as Record<string, unknown> | null;
  const rationale = String(prop?.rationale ?? "");
  if (isOnchainRejection(r))
    return {
      label: "Rejected by Solana rule",
      reason: plainError(r.error_code!),
      tone: "reject",
    };
  if (r.error_code === "WindowMissed")
    return {
      label: "Not sent",
      reason: "Too late for this round; nothing was sent.",
      tone: "hold",
    };
  if (r.error_code === "EpochNotFound")
    return {
      label: "Not sent",
      reason: "No round was open to join.",
      tone: "hold",
    };
  if (r.error_code === "Transient" || (r.status ?? "").toLowerCase() === "submit_failed")
    return {
      label: "Not sent",
      reason: "Network hiccup; nothing was sent.",
      tone: "hold",
    };
  if (r.error_code === "PlanBusy")
    return {
      label: "Not sent",
      reason: "Plan was busy with another round.",
      tone: "hold",
    };
  if (r.error_code === "WorkerRestart")
    return {
      label: "Interrupted",
      reason: "The bot restarted mid-decision; nothing was sent.",
      tone: "hold",
    };
  if (r.error_code)
    return {
      label: "Not sent",
      reason: explainError(r.error_code) ?? "Stopped before sending.",
      tone: "hold",
    };
  const s = (r.final?.status ?? r.status ?? "").toLowerCase();
  if (s === "open") {
    const what = prop?.size && prop?.strike ? `${fmtSize(Number(prop.size) / 1e9)} SOL at ${usdcPrice(prop.strike as string)}` : "a round";
    if (r.tx_sig)
      return {
        label: "Opened a round",
        reason: `Pay met your minimum, so it offered ${what}.`,
        tone: "open",
      };
    return {
      label: r.kind === "preview" ? "Preview" : "Suggested",
      reason: `Suggested ${what}; not sent.`,
      tone: "neutral",
    };
  }
  if (s === "skip") return { label: "AI waited", reason: waitReason(rationale), tone: "hold" };
  if (s === "vetoed")
    return {
      label: "Risk check said no",
      reason: vetoReason(r.final?.reason ?? ""),
      tone: "hold",
    };
  if (s === "flip")
    return {
      label: "Switched to selling",
      reason: "Buying is done; now selling at your exit price.",
      tone: "open",
    };
  if (s === "stop")
    return {
      label: "Stopped",
      reason: /fully met|size_remaining 0|goal is (?:already )?(?:met|filled)/i.test(rationale)
        ? "Your goal is fully filled, so it stopped."
        : "The AI stopped working on this plan.",
      tone: "hold",
    };
  if (s === "error")
    return {
      label: "Error",
      reason: "Something broke; nothing was sent.",
      tone: "hold",
    };
  return {
    label: "Thinking…",
    reason: "The AI is deciding now.",
    tone: "neutral",
  };
}

export function DeskFeed() {
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);
  const runs = useTable<DeskRunRow>({
    table: "desk_runs",
    orderBy: "created_at",
    ascending: false,
    limit: 300,
    pollMs: 10_000,
  });
  const rows = useMemo(() => (runs.status === "ready" ? runs.rows : []), [runs]);

  const rejections = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- relative window, recomputed with each data refresh
    const since = Date.now() - WINDOW_H * 3600_000;
    return rows.filter((r) => isOnchainRejection(r) && Date.parse(r.created_at) >= since).length;
  }, [rows]);

  const shown = rows.filter((r) => {
    const c = describe(r).tone;
    if (filter === "rejected") return c === "reject";
    if (filter === "opened") return c === "open";
    if (filter === "held") return c === "hold";
    return true;
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          Times Solana rejected the AI:{" "}
          <span className={cn("num font-semibold", runs.status === "ready" && rejections > 0 && "text-destructive")}>
            {runs.status === "ready" ? rejections : "—"}
          </span>
          <span className="text-xs text-muted-foreground"> in the last {WINDOW_H} h</span>
        </p>
        <div role="tablist" aria-label="Filter decisions" className="flex w-fit max-w-full flex-wrap gap-1 rounded-full border border-border bg-card p-1">
          {(
            [
              ["all", "All"],
              ["opened", "Opened"],
              ["held", "Waited"],
              ["rejected", "Rejected"],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <Button
              key={id}
              role="tab"
              aria-selected={filter === id}
              variant="ghost"
              className={cn(
                "h-9 rounded-full px-3.5 text-[13px]",
                filter === id ? "bg-secondary text-primary hover:bg-secondary hover:text-primary" : "text-muted-foreground",
              )}
              onClick={() => {
                setFilter(id);
                setLimit(PAGE);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {runs.status === "unconfigured" ? (
        <EmptyState title="Data feed not configured">Connect the data feed to see decisions.</EmptyState>
      ) : runs.status === "loading" ? (
        <div className="grid gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : runs.status === "error" ? (
        <EmptyState
          title="Couldn't load decisions"
          action={
            <Button variant="outline" onClick={runs.reload}>
              Try again
            </Button>
          }
        >
          {runs.message}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title={filter === "all" ? "No decisions yet" : "Nothing here yet"}>New decisions appear here live.</EmptyState>
      ) : (
        <div className="grid gap-3">
          <ol className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {shown.slice(0, limit).map((r) => {
              const d = describe(r);
              return (
                <li
                  key={r.id}
                  className={cn(
                    "grid gap-2 px-4 py-3 animate-in fade-in-0 duration-300 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4 sm:px-5",
                    d.tone === "reject" && "border-l-2 border-l-destructive",
                  )}
                >
                  <div className="grid min-w-0 gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{timeAgo(r.created_at)}</span>
                      {r.plan_pubkey && (
                        <>
                          <span aria-hidden>·</span>
                          <Link href={`/plan/${r.plan_pubkey}`} className="hover:text-foreground">
                            Plan {shortAddr(r.plan_pubkey)}
                          </Link>
                        </>
                      )}
                      <span aria-hidden>·</span>
                      <Badge variant={d.tone === "reject" ? "destructive" : d.tone === "open" ? "default" : "secondary"} className="rounded-full">
                        {d.label}
                      </Badge>
                    </div>
                    <p className="text-[13px] text-pretty">{d.reason}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {r.tx_sig && (
                      <ExplorerLink sig={r.tx_sig} className="text-xs">
                        Proof on Solana
                      </ExplorerLink>
                    )}
                    <RunDetail
                      run={r}
                      trigger={
                        <Button variant="secondary" className="h-9 rounded-full">
                          Details
                        </Button>
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          {shown.length > limit && (
            <Button variant="outline" className="h-9 w-fit justify-self-center rounded-full" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({shown.length - limit} left)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
