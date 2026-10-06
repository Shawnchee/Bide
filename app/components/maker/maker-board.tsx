"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Gavel, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ExplorerLink } from "@/components/site/bits";
import { WalletButton } from "@/components/site/wallet-button";
import type { DecodedRound } from "@/lib/bide-client";
import { auctionPhase, auctionPrice } from "@/lib/auction";
import { dateTimeUtc, duration, usdc, usdcPrice } from "@/lib/format";
import { fmtSize } from "@/lib/plan-math";
import { sendAndConfirm } from "@/lib/send";
import { buildTakeRoundTx, explainTxError } from "@/lib/tx";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rounds: DecodedRound[] };

function AuctionCard({ r, now }: { r: DecodedRound; now: number }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [busy, setBusy] = useState(false);
  const [won, setWon] = useState<string | null>(null);
  const price = auctionPrice(r, now);
  const phase = auctionPhase(r, now);
  const size = Number(r.size) / 1e9;
  const put = r.kind === "put";
  const elapsedPct = Math.min(100, Math.max(0, ((now - r.auctionStart) / Math.max(1, r.auctionSecs)) * 100));

  const take = async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      const tx = await buildTakeRoundTx(connection, publicKey, r);
      const sig = await sendAndConfirm(connection, sendTransaction, tx);
      setWon(sig);
      toast.success("You won the auction");
    } catch (e) {
      const { message, cancelled } = explainTxError(e);
      if (!cancelled) toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="grid min-w-0 gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="rounded-full">
          {put ? "Put" : "Call"} · strike {usdcPrice(r.strike)}
        </Badge>
        <span className="num text-xs text-muted-foreground">
          {fmtSize(size)} SOL · expires {dateTimeUtc(r.expiry)}
        </span>
        <ExplorerLink address={r.pubkey} className="ml-auto text-xs">
          Round
        </ExplorerLink>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl bg-secondary p-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Price now</p>
          <p className="num mt-0.5 text-3xl font-semibold tracking-tight">{usdc(price)}</p>
          <p className="num mt-1 text-xs text-muted-foreground">
            from {usdc(r.premiumStart)} to floor {usdc(r.premiumFloor)}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {phase === "falling" && <p>falling · {duration(r.auctionStart + r.auctionSecs - now)} left</p>}
          {phase === "floor" && <p>at floor · {duration(r.auctionStart + r.auctionSecs + r.poolDelaySecs - now)} before the pool</p>}
          {phase === "pool" && <p>pool window open</p>}
          {phase === "over" && <p>ended</p>}
        </div>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-linear" style={{ width: `${elapsedPct}%` }} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        You pay the premium now and escrow {put ? `${fmtSize(size)} SOL` : usdc(r.notional)}. At expiry, if the settlement price is{" "}
        {put ? "below" : "above"} the strike, you receive {put ? usdc(r.notional) : `${fmtSize(size)} SOL`}; otherwise your escrow comes back.
      </p>
      {won ? (
        <p className="text-sm text-primary">
          Taken. <ExplorerLink sig={won}>View transaction</ExplorerLink>
        </p>
      ) : !publicKey ? (
        <WalletButton size="lg" className="h-11 w-full rounded-xl" />
      ) : (
        <Button size="lg" className="h-11 w-full rounded-xl" onClick={take} disabled={busy || phase === "pool" || phase === "over"}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Gavel aria-hidden />}
          Take at {usdc(price)}
        </Button>
      )}
    </li>
  );
}

export function MakerBoard() {
  const { connection } = useConnection();
  const now = useNow(500);
  const program = useProgram();
  const client = program.status === "ready" ? program.client : null;
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const rounds = await client.fetchAuctionRounds(connection);
      setLoad({ status: "ready", rounds: rounds.filter((r) => r.status === "auction") });
    } catch (e) {
      setLoad({ status: "error", message: e instanceof Error ? e.message : "RPC error" });
    }
  }, [client, connection]);

  useEffect(() => {
    if (!client) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [client, refresh]);

  if (program.status === "checking") return <Skeleton className="h-64" />;
  if (!client)
    return (
      <EmptyState icon={<Gavel />} title="The Bide program isn't on devnet yet">
        Auctions are read straight from the program, so they appear here as soon as it&apos;s deployed.
      </EmptyState>
    );
  if (load.status === "loading")
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  if (load.status === "error")
    return (
      <EmptyState title="Couldn't read auctions from Solana" action={<Button variant="outline" onClick={refresh}>Try again</Button>}>
        {load.message}
      </EmptyState>
    );
  const live = load.rounds.filter((r) => auctionPhase(r, now) !== "over");
  if (live.length === 0)
    return (
      <EmptyState icon={<Gavel />} title="No auctions running right now">
        Standard rounds auction daily from 08:00 to 08:30 UTC; quick rounds open at the start of every 10-minute window. This page checks
        Solana every few seconds.
      </EmptyState>
    );
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {live.map((r) => (
        <AuctionCard key={r.pubkey} r={r} now={now} />
      ))}
    </ul>
  );
}
