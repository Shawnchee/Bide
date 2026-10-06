import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { AuctionTape } from "@/components/auctions/tape";
import { AuctionStats } from "@/components/auctions/stats";
import { MakerLedger } from "@/components/agents/maker-ledger";

export const metadata: Metadata = { title: "Auctions" };

export default function AuctionsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader title="Auctions">Who bid on each round, and what they paid.</PageHeader>
      <AuctionStats />
      <section aria-labelledby="makers-h" className="mb-8 grid gap-3">
        <div className="grid gap-1">
          <h2 id="makers-h" className="text-sm font-semibold">
            Two AI makers, opposing theses
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">They see only public data. The program picks the winner.</p>
        </div>
        <MakerLedger />
      </section>
      <AuctionTape />
    </div>
  );
}
