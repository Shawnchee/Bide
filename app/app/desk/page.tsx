import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { DeskFeed } from "@/components/desk/desk-feed";
import { TrackRecord } from "@/components/desk/track-record";

export const metadata: Metadata = { title: "Desk" };

export default function DeskPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader eyebrow="Live" title="The agent desk">
        Every decision the AI desk makes, including the ones the Solana program refused. Open any run to see the tool calls, Risk&apos;s
        probabilities and the memo hash stored on-chain.
      </PageHeader>
      <div className="grid gap-8">
        <TrackRecord />
        <DeskFeed />
      </div>
    </div>
  );
}
