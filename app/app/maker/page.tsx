import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { MakerBoard } from "@/components/maker/maker-board";

export const metadata: Metadata = { title: "Maker" };

export default function MakerPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader eyebrow="For traders" title="Take the other side">
        Live Dutch auctions, read straight from Solana. The price starts at 1.3× the exchange fair value and falls toward a floor near the
        best exchange bid. First wallet to take it wins — no whitelist.
      </PageHeader>
      <MakerBoard />
    </div>
  );
}
