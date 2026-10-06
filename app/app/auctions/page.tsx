import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { AuctionTape } from "@/components/auctions/tape";
import { MakerLedger } from "@/components/agents/maker-ledger";

export const metadata: Metadata = { title: "Auctions" };

export default function AuctionsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader eyebrow="Public tape" title="Every auction, in the open">
        Start and floor prices are anchored to live exchange option quotes. See who won each round and what they paid.
      </PageHeader>
      <section aria-labelledby="makers-h" className="mb-8 grid gap-3">
        <div className="grid gap-1">
          <h2 id="makers-h" className="text-sm font-semibold">
            Two AI makers, opposing theses
          </h2>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            The Event desk reads the macro calendar and venue agreement; the Momentum desk reads recent price moves. Before each auction
            window each one picks a stance (how far below exchange fair value it will pay) and a short thesis; code turns that into a bid
            for every round and the Solana program decides who wins. The makers see only public on-chain round data and market data — never
            the seller desk&apos;s memo, its proposal, or any user&apos;s limits. Every number in a thesis must come from that data, or the
            maker falls back to a fixed rule, labelled &ldquo;Fallback&rdquo;.
          </p>
        </div>
        <MakerLedger />
      </section>
      <AuctionTape />
    </div>
  );
}
