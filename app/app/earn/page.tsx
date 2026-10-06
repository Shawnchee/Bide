import type { Metadata } from "next";
import { EarnFlow } from "@/components/earn/earn-flow";

export const metadata: Metadata = { title: "Earn" };

export default function EarnPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <EarnFlow />
    </div>
  );
}
