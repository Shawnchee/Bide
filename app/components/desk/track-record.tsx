"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { MAKER_PERSONAS } from "@/components/agents/maker-bids";
import type { RoundRow } from "@/lib/types";
import { useTable } from "@/hooks/use-table";

const BOTS = (process.env.NEXT_PUBLIC_MAKER_BOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const TAKEN = new Set(["live", "resolved", "settled", "unwound"]);
const RESOLVED = new Set(["resolved", "settled"]);
const N = 20;

const big = (v: unknown) => {
  try {
    return BigInt(String(v ?? "0").split(".")[0]!);
  } catch {
    return 0n;
  }
};

/** Same definitions as worker/src/agents/outcomes.ts (the desk's recent_outcomes tool). Display only. */
function stats(rows: RoundRow[]) {
  const finished = rows.filter((r) => String(r.status).toLowerCase() !== "auction");
  const taken = finished.filter((r) => TAKEN.has(String(r.status).toLowerCase()) && big(r.premium_paid) > 0n);
  const ratios = taken.filter((r) => big(r.premium_start) > 0n).map((r) => Number(big(r.premium_paid)) / Number(big(r.premium_start)));
  const secs = taken
    .filter((r) => !r.is_pool && r.auction_secs)
    .map((r) => {
      const s = big(r.premium_start), f = big(r.premium_floor), p = big(r.premium_paid);
      return s <= f ? 0 : Math.max(0, Math.min(r.auction_secs!, Math.round((Number(s - p) * r.auction_secs!) / Number(s - f))));
    })
    .sort((a, b) => a - b);
  const resolved = finished.filter((r) => RESOLVED.has(String(r.status).toLowerCase()));
  const exercised = resolved.filter((r) => r.exercised === 2 || r.exercised === true);
  const wins: Record<string, number> = {};
  for (const r of taken) {
    const i = r.maker ? BOTS.indexOf(r.maker) : -1;
    const w = r.is_pool ? "Pool" : i >= 0 ? (MAKER_PERSONAS[`maker-${i + 1}`] ?? `Maker ${i + 1}`) : "Other";
    wins[w] = (wins[w] ?? 0) + 1;
  }
  const median = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2]! : (secs[secs.length / 2 - 1]! + secs[secs.length / 2]!) / 2) : null;
  return {
    finished: finished.length,
    fillRate: finished.length ? taken.length / finished.length : null,
    untaken: finished.filter((r) => String(r.status).toLowerCase() === "cancelled").length,
    fillOverStart: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    medianSecs: median,
    exerciseRate: resolved.length ? exercised.length / resolved.length : null,
    resolved: resolved.length,
    wins,
  };
}

const pctS = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** "What the desk learned": the deterministic statistics the Quant reads through recent_outcomes and must cite. */
export function TrackRecord() {
  const rounds = useTable<RoundRow>({ table: "rounds", orderBy: "auction_start", ascending: false, limit: N, pollMs: 15_000 });
  if (rounds.status === "unconfigured" || rounds.status === "error") return null;
  if (rounds.status === "loading") return <Skeleton className="h-32 w-full" />;
  const s = stats(rounds.rows);
  const cells: [string, string, string?][] = [
    ["Fill rate", pctS(s.fillRate), `${s.finished} finished auctions`],
    ["Paid ÷ start price", s.fillOverStart === null ? "—" : s.fillOverStart.toFixed(2), "how far the price fell before a taker"],
    ["Median time to fill", s.medianSecs === null ? "—" : `${s.medianSecs} s`, "from auction start"],
    ["Untaken", String(s.untaken), "auctions nobody took"],
    ["Filled at expiry", pctS(s.exerciseRate), `${s.resolved} settled rounds`],
  ];
  return (
    <section aria-labelledby="track-h" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="track-h" className="text-sm font-semibold">
          What the desk learned
        </h2>
        <p className="max-w-3xl text-xs text-muted-foreground">
          Before each round the desk reads these statistics from the last {N} rounds (per plan and per asset) and must cite them in its
          reasoning. They can shape auction length, expiry, size or a skip — never your limits or your price. Computed by code, not by a
          model; with few rounds so far, treat them as thin evidence. Quick rounds are mostly taken by Bide&apos;s own makers.
        </p>
      </div>
      {rounds.rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">No finished rounds yet — the statistics appear after the first auction.</p>
      ) : (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-5">
          {cells.map(([label, value, sub]) => (
            <div key={label} className="bg-card p-4 last:col-span-2 sm:last:col-span-1">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="num mt-1 text-xl font-semibold tracking-tight">{value}</p>
              {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
            </div>
          ))}
        </div>
      )}
      {Object.keys(s.wins).length > 0 && (
        <p className="text-xs text-muted-foreground">
          Who took the rounds:{" "}
          {Object.entries(s.wins)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}
