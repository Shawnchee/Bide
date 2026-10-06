"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Waitlist() {
  const { publicKey } = useWallet();
  const [email, setEmail] = useState("");
  const [price, setPrice] = useState("");
  const [state, setState] = useState<{ s: "idle" | "busy" | "done" } | { s: "error"; msg: string }>({ s: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ s: "busy" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, price, wallet: publicKey?.toBase58() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setState({ s: "error", msg: body.error ?? "Something went wrong." });
      else setState({ s: "done" });
    } catch {
      setState({ s: "error", msg: "Couldn't reach the server. Try again." });
    }
  };

  if (state.s === "done") {
    return (
      <p className="flex items-center gap-2 text-lg" role="status">
        <Check className="size-5 text-primary" aria-hidden /> You&apos;re on the list. We&apos;ll email you when Bide reaches mainnet.
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="wl-email">Email</Label>
        <Input id="wl-email" type="email" autoComplete="email" required className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="wl-price">At what price would you buy SOL? (optional)</Label>
        <Input id="wl-price" inputMode="decimal" autoComplete="off" placeholder="$" className="h-11" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>
      <Button type="submit" className="h-11 rounded-xl px-6" disabled={state.s === "busy"}>
        {state.s === "busy" && <Loader2 className="animate-spin" aria-hidden />}
        Join the waitlist
      </Button>
      {state.s === "error" && (
        <p className="text-sm text-destructive sm:col-span-3" role="alert">
          {state.msg}
        </p>
      )}
    </form>
  );
}
