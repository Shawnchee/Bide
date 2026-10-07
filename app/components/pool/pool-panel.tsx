"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { WalletButton } from "@/components/site/wallet-button";
import { ExplorerLink } from "@/components/site/bits";
import { USDC_MINT, WSOL_MINT } from "@/lib/constants";
import { toBaseUnits } from "@/lib/plan-math";
import { sendAndConfirm } from "@/lib/send";
import { buildPoolTx, explainTxError } from "@/lib/tx";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { useProgram } from "@/hooks/use-program";
import { cn } from "@/lib/utils";

export function PoolPanel() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const program = useProgram();
  const client = program.status === "ready" ? program.client : null;
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [mint, setMint] = useState<"USDC" | "WSOL">("USDC");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const builderReady = mode === "deposit" ? Boolean(client?.poolDepositIxs) : Boolean(client?.poolWithdrawIxs);
  const bal = useTokenBalance(mint === "USDC" ? USDC_MINT : WSOL_MINT, nonce);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    const n = Number(amount);
    if (!(n > 0)) return toast.error("Enter an amount above zero.");
    setBusy(true);
    try {
      const tx =
        mode === "deposit"
          ? await buildPoolTx(connection, publicKey, {
              kind: "deposit",
              mint: mint === "USDC" ? USDC_MINT : WSOL_MINT,
              amount: toBaseUnits(n, mint === "USDC" ? 6 : 9),
            })
          : await buildPoolTx(connection, publicKey, { kind: "withdraw", shares: toBaseUnits(n, 6) });
      const s = await sendAndConfirm(connection, { sendTransaction, signTransaction }, tx);
      setSig(s);
      setNonce((x) => x + 1);
      toast.success(mode === "deposit" ? "Deposited" : "Withdrawn");
    } catch (err) {
      const { message, cancelled } = explainTxError(err);
      if (!cancelled) toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid content-start gap-3 rounded-2xl border border-border bg-card p-4">
      <div role="tablist" className="flex gap-1">
        {(["deposit", "withdraw"] as const).map((m) => (
          <Button key={m} type="button" role="tab" aria-selected={mode === m} variant="ghost" className={cn("h-9 rounded-full px-4 capitalize", mode === m ? "bg-secondary text-primary hover:bg-secondary hover:text-primary" : "text-muted-foreground")} onClick={() => setMode(m)}>
            {m}
          </Button>
        ))}
      </div>
      <div className="swap-panel">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="pool-amt" className="text-xs font-medium text-muted-foreground">{mode === "deposit" ? "You deposit" : "Pool shares to withdraw"}</Label>
          {mode === "deposit" && publicKey && bal !== null && (
            <p className="num text-xs text-muted-foreground">
              Wallet {bal.toLocaleString("en-US", { maximumFractionDigits: 4 })} {mint}
            </p>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <input id="pool-amt" inputMode="decimal" autoComplete="off" placeholder="0.00" className="swap-input" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          {mode === "withdraw" && <span className="swap-pill">Shares</span>}
        </div>
      {mode === "deposit" && (
        <div role="radiogroup" aria-label="Token" className="mt-3 flex gap-1.5">
          {(["USDC", "WSOL"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mint === m}
              onClick={() => setMint(m)}
              className={cn(
                "h-9 rounded-full border px-4 text-[13px] font-semibold transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                mint === m ? "border-primary/60 bg-accent text-accent-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      </div>
      {!publicKey ? (
        <WalletButton size="lg" className="h-12 w-full rounded-xl text-base" />
      ) : (
        <Button type="submit" size="lg" className="h-12 w-full rounded-xl text-base" disabled={!builderReady || busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {!builderReady ? `${mode === "deposit" ? "Deposits" : "Withdrawals"} from the app — coming soon` : mode === "deposit" ? "Deposit" : "Withdraw"}
        </Button>
      )}
      {!builderReady && (
        <p className="text-xs text-muted-foreground">
          The pool is live on devnet and already backstopping auctions. {mode === "deposit" ? "Depositing" : "Withdrawing"} from this page is coming soon.
        </p>
      )}
      {sig && <ExplorerLink sig={sig}>View transaction</ExplorerLink>}
    </form>
  );
}
