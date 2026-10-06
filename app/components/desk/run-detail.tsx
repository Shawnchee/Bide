"use client";

import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ExplorerLink } from "@/components/site/bits";
import { explainError, runRiskAnswers, runToolTraces, stepLabel, type RiskAnswersLike } from "@/lib/desk";
import { timeAgo, usdc, dateTimeUtc, usdcPrice } from "@/lib/format";
import type { DeskRunRow } from "@/lib/types";

const QUESTION_LABEL: Record<string, string> = {
  verdict: "Verdict",
  event_risk: "Event risk",
  data_quality: "Data quality",
  user_fit: "Fits the user's patience",
  explanation_ok: "Reasons match the numbers",
};

function Bars({ answers }: { answers: RiskAnswersLike }) {
  return (
    <div className="grid gap-4">
      {Object.entries(answers).map(([q, dist]) => {
        if (!dist || typeof dist !== "object") return null;
        const entries = Object.entries(dist as Record<string, number>).sort((a, b) => b[1] - a[1]);
        return (
          <div key={q} className="grid gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">{QUESTION_LABEL[q] ?? q}</p>
            {entries.map(([opt, p], i) => (
              <div key={opt} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-2 text-sm">
                <span className={i === 0 ? "font-medium" : "text-muted-foreground"}>{opt.replace(/_/g, " ")}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(p * 100)}%` }} />
                </span>
                <span className="num text-right text-xs">{Math.round(p * 100)}%</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="num mt-2 max-h-56 overflow-auto rounded-lg bg-secondary p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function proposalLine(p: Record<string, unknown> | null | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.strike) parts.push(`at ${usdcPrice(p.strike as string)}`);
  if (p.size) parts.push(`${Number(p.size) / 1e9} SOL`);
  if (p.expiry) parts.push(`ends ${dateTimeUtc(p.expiry as number)}`);
  if (p.premium_floor) parts.push(`min pay ${usdc(p.premium_floor as string)}`);
  return parts.length ? parts.join(" · ") : null;
}

export function RunDetail({ run, trigger, onChainMemoHash }: { run: DeskRunRow; trigger: ReactNode; onChainMemoHash?: string | null }) {
  const answers = runRiskAnswers(run);
  const traces = runToolTraces(run.memo);
  const proposal = (run.final?.proposal ?? run.proposal) as Record<string, unknown> | null;
  const rationale = (proposal?.rationale as string) ?? null;
  const retry = Boolean((run.memo as { inputs?: { chain_retry?: unknown } } | null)?.inputs?.chain_retry);
  const cites = (run.memo as { outcomes_cited?: boolean | null } | null)?.outcomes_cited === true;
  const matches = onChainMemoHash && run.memo_hash ? onChainMemoHash.replace(/^0x/, "") === run.memo_hash.replace(/^0x/, "") : null;

  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-display text-xl">Details</SheetTitle>
          <SheetDescription>
            {timeAgo(run.created_at)} · the full record, for anyone checking.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-8 px-4 pb-10">
          <section className="grid gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">What happened</h3>
            {(retry || cites) && (
              <p className="text-xs text-muted-foreground">
                {[retry && "Retry after a Solana rejection", cites && "Used past round results"].filter(Boolean).join(" · ")}
              </p>
            )}
            <p className="text-[15px] leading-snug font-medium">{run.final?.reason ?? rationale ?? run.final?.status ?? "—"}</p>
            {proposalLine(proposal) && <p className="num text-sm text-muted-foreground">{proposalLine(proposal)}</p>}
            {rationale && run.final?.reason && rationale !== run.final.reason && (
              <p className="text-sm text-muted-foreground">AI&apos;s full why: {rationale}</p>
            )}
            {run.error_code && (
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {run.status === "rejected" && run.tx_sig ? "Rejected by Solana rule" : "Not sent"}: <span className="font-mono text-xs">{run.error_code}</span>
                {explainError(run.error_code) ? ` — ${explainError(run.error_code)}.` : ""}
              </p>
            )}
          </section>

          {answers && (
            <section className="grid gap-3">
              <h3 className="text-xs font-semibold text-muted-foreground">Risk check scores</h3>
              <Bars answers={answers} />
            </section>
          )}

          {traces.length > 0 && (
            <section className="grid gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground">Data the AI checked ({traces.length})</h3>
              <p className="text-xs text-muted-foreground">Every number came from these code tools.</p>
              <ul className="grid gap-2">
                {traces.map((t, i) => (
                  <li key={i} className="rounded-xl border border-border p-3">
                    <details>
                      <summary className="flex cursor-pointer items-center gap-2 text-sm">
                        {t.ok === false ? <X className="size-4 text-destructive" aria-hidden /> : <Check className="size-4 text-primary" aria-hidden />}
                        <span className="font-mono text-xs">{t.name}</span>
                        {typeof t.duration_ms === "number" && <span className="ml-auto text-xs text-muted-foreground">{t.duration_ms} ms</span>}
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">Arguments</p>
                      <Json value={t.args} />
                      <p className="mt-2 text-xs text-muted-foreground">{t.ok === false ? "Error" : "Result"}</p>
                      <Json value={t.ok === false ? t.error : t.result} />
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {run.steps && run.steps.length > 0 && (
            <section className="grid gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground">Steps</h3>
              <ol className="grid gap-1 text-sm text-muted-foreground">
                {run.steps.map((s, i) => (
                  <li key={i}>{stepLabel(s)}</li>
                ))}
              </ol>
            </section>
          )}

          <section className="grid gap-2 rounded-xl bg-secondary p-4 text-sm">
            <h3 className="font-medium">Proof on Solana</h3>
            <p className="text-muted-foreground">A fingerprint of this full record is saved on Solana.</p>
            <p className="font-mono break-all text-[11px]" title="SHA-256 memo hash">{run.memo_hash ?? "No fingerprint (no round was opened)"}</p>
            {matches === true && <p className="text-primary">Matches the one saved on Solana ✓</p>}
            {matches === false && <p className="text-destructive">Doesn&apos;t match the one on Solana.</p>}
            {run.tx_sig && (
              <p>
                <ExplorerLink sig={run.tx_sig}>View the transaction</ExplorerLink>
              </p>
            )}
          </section>

          {run.memo && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Full record (JSON)</summary>
              <Json value={run.memo} />
            </details>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
