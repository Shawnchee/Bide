"use client";

import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** The only place options vocabulary appears in the earn flow (SPEC §5). */
export function HowItWorks() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" className="-ml-3 h-10 gap-2 text-sm">
          <BookOpen className="size-4" aria-hidden /> How it works under the hood
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-display text-xl">Under the hood</SheetTitle>
          <SheetDescription>For the curious. You don&apos;t need any of this to use Bide.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-6 px-4 pb-8 text-sm leading-relaxed">
          <section className="grid gap-2">
            <h3 className="font-medium">&ldquo;Buy cheaper&rdquo; is a cash-secured put</h3>
            <p className="text-muted-foreground">
              Each round, you sell a put option at your price. A buyer pays you a premium upfront. Your USDC sits in Jupiter Lend as
              collateral. At expiry, if the settlement price is below your price, you buy the SOL at exactly your price; otherwise you keep
              your USDC. You keep the premium either way.
            </p>
          </section>
          <section className="grid gap-2">
            <h3 className="font-medium">&ldquo;Sell higher&rdquo; is a covered call</h3>
            <p className="text-muted-foreground">
              Same idea in reverse: your SOL (as WSOL in Jupiter Lend) backs a call option at your sell price.
            </p>
          </section>
          <section className="grid gap-2">
            <h3 className="font-medium">Who pays you, and how much</h3>
            <p className="text-muted-foreground">
              A Dutch auction starts at 1.3× the fair value from real exchange option quotes (Deribit, OKX, Bybit, Binance) and falls to a
              floor near the best exchange bid. Any wallet can take it. If no one does, a public backstop pool buys at the floor. Bide keeps
              10% of each premium as its fee; every number we show you is after that fee.
            </p>
          </section>
          <section className="grid gap-2">
            <h3 className="font-medium">How the price is checked</h3>
            <p className="text-muted-foreground">
              Settlement uses the median of Pyth price samples taken in a short window right before expiry — once, at the end of the round.
              It is not triggered when the price touches your level mid-round.
            </p>
          </section>
          <section className="grid gap-2">
            <h3 className="font-medium">The AI desk can&apos;t break your limits</h3>
            <p className="text-muted-foreground">
              Two AI models pick each round&apos;s timing and size: one proposes, one judges risk. Your limits (price, deadline, minimum pay)
              are stored in the Solana program, which rejects anything outside them. Every decision memo is hashed on-chain.
            </p>
          </section>
          <section className="grid gap-2">
            <h3 className="font-medium">Risks, plainly</h3>
            <p className="text-muted-foreground">
              If you&apos;re buying and the price crashes far below your level, you still buy at your price. If you&apos;re selling and the
              price rockets, you still sell at your price. This runs on Solana devnet with test tokens and has not been audited.
            </p>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
