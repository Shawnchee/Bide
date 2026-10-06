"use client";

import { Badge } from "@/components/ui/badge";
import { ExplorerLink } from "@/components/site/bits";
import { usdc } from "@/lib/format";
import type { MakerBidRow } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The two maker agents (worker/src/agents/maker/personas.ts). */
export const MAKER_PERSONAS: Record<string, string> = { "maker-1": "Event desk", "maker-2": "Momentum desk" };

/** Plain-language style of each AI buyer (maker persona). */
export const BUYER_STYLE: Record<string, string> = { "maker-1": "watches news events", "maker-2": "follows price trends" };

/** "maker-1" → "AI buyer 1". */
export const buyerName = (m: string) => (m.startsWith("maker-") ? `AI buyer ${m.slice("maker-".length)}` : m);

/** Kept for existing callers; now the plain buyer name. */
export const makerLabel = buyerName;

/** Did this bid win the round? (the take tx is recorded on the row; the mirror's maker pubkey is the fallback check) */
export const bidWon = (b: MakerBidRow, roundMaker?: string | null) => b.took || (!!roundMaker && roundMaker === b.maker_pubkey);

export function SourceBadge({ source }: { source: string }) {
  if (source === "llm") return null;
  return (
    <Badge variant="outline" className="rounded-full text-muted-foreground" title="The AI didn't answer in time, so a simple rule bid">
      Backup bot
    </Badge>
  );
}

/** Each AI buyer's bid for one round: offer (or pass), how sure, win, and its short reason. */
export function MakerBidList({ bids, roundMaker, className }: { bids: MakerBidRow[]; roundMaker?: string | null; className?: string }) {
  if (bids.length === 0) return null;
  const sorted = [...bids].sort((a, b) => a.maker.localeCompare(b.maker));
  return (
    <ul className={cn("grid gap-2 sm:grid-cols-2", className)}>
      {sorted.map((b) => {
        const won = bidWon(b, roundMaker);
        const passed = b.stance === "pass" || b.bid === null;
        return (
          <li key={b.id} className={cn("grid min-w-0 gap-1.5 rounded-xl border p-3 text-[13px]", won ? "border-primary/40 bg-accent/50" : "border-border bg-secondary/40")}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{buyerName(b.maker)}</span>
              <SourceBadge source={b.source} />
              {won && <Badge>Paid</Badge>}
            </div>
            <p className="num text-xs text-muted-foreground">
              {passed ? (
                "Didn't bid"
              ) : (
                <>
                  Offered <span className="text-foreground">{usdc(b.bid)}</span>
                  {b.fair_at_bid !== null && <> · fair price {usdc(b.fair_at_bid)}</>}
                </>
              )}
              {b.confidence !== null && <> · {Math.round(b.confidence * 100)}% sure</>}
            </p>
            {b.thesis && <p className="text-xs text-pretty text-muted-foreground">&ldquo;{b.thesis}&rdquo;</p>}
            {b.source !== "llm" && b.reason && <p className="text-xs text-muted-foreground">Why backup bot: {b.reason}</p>}
            {won && b.pnl_usdc !== null && (
              <p className={cn("num text-xs", Number(b.pnl_usdc) < 0 ? "text-destructive" : "text-positive")}>
                Buyer profit/loss: {Number(b.pnl_usdc) >= 0 ? "+" : ""}
                {usdc(b.pnl_usdc)}
              </p>
            )}
            {b.tx_sig && (
              <ExplorerLink sig={b.tx_sig} className="text-xs">
                Proof on Solana
              </ExplorerLink>
            )}
          </li>
        );
      })}
    </ul>
  );
}
