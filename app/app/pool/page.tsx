import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { PoolPanel } from "@/components/pool/pool-panel";
import { PoolStatus } from "@/components/pool/pool-status";

export const metadata: Metadata = { title: "Backstop pool" };

export default function PoolPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader eyebrow="For liquidity providers" title="Backstop pool">
        When no trader takes an auction, the pool buys at the floor price so the user still gets paid. The pool is live on devnet and
        backstopping auctions now; deposits for USDC or SOL (in return for pool shares) open from this page soon.
      </PageHeader>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-labelledby="risk-h" className="grid content-start gap-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-warning-foreground sm:p-5">
          <h2 id="risk-h" className="text-sm font-semibold">
            Read this before depositing
          </h2>
          <ul className="grid list-disc gap-1.5 pl-5 text-[13px] leading-relaxed">
            <li>The pool is an option buyer. It pays a premium upfront for every round it takes, and most rounds end without paying anything back.</li>
            <li>It only gets the rounds every trader passed on, so expect to lose money on average. It wins on big moves (a crash pays out on buy rounds, a rally on sell rounds).</li>
            <li>Max loss per round is the premium paid. Results are lumpy.</li>
            <li>Version 1 is unhedged. On-chain caps limit premium per round, open exposure and how much of the pool can be locked at once.</li>
            <li>Idle USDC is parked in Jupiter Lend. Withdrawals pay out from funds not locked in live rounds, in the tokens the pool holds.</li>
            <li>Devnet, unaudited, test tokens only.</li>
          </ul>
        </section>
        <div className="grid content-start gap-4">
          <PoolStatus />
          <PoolPanel />
        </div>
      </div>
    </div>
  );
}
