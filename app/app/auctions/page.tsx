import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { AuctionTape } from "@/components/auctions/tape";
import { AuctionStats } from "@/components/auctions/stats";
import { MakerLedger } from "@/components/agents/maker-ledger";

export const metadata: Metadata = { title: "Auctions" };

export default function AuctionsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader title="Who paid what, every round." />
      <AuctionStats />
      <section aria-labelledby="buyers-h" className="mb-8 grid gap-3">
        <div className="grid gap-1">
          <h2 id="buyers-h" className="text-sm font-semibold">
            Buyer profit/loss
          </h2>
          <p className="text-xs text-muted-foreground">Two AI buyers (market makers) bid on each round.</p>
        </div>
        <MakerLedger />
      </section>
      <AuctionTape />
    </div>
  );
}
