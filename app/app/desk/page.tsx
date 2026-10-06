import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { DeskFeed } from "@/components/desk/desk-feed";
import { TrackRecord } from "@/components/desk/track-record";

export const metadata: Metadata = { title: "Desk" };

export default function DeskPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader title="The AI desk">Every AI decision, including ones the program refused.</PageHeader>
      <div className="grid gap-8">
        <DeskFeed />
        <TrackRecord />
      </div>
    </div>
  );
}
