import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlanView } from "@/components/plan/plan-view";
import { isPubkey } from "@/lib/pda";

export const metadata: Metadata = { title: "Plan" };

export default async function PlanPage({ params, searchParams }: PageProps<"/plan/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isPubkey(id)) notFound();
  const sig = typeof sp.sig === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sp.sig) ? sp.sig : null;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <PlanView id={id} createSig={sig} />
    </div>
  );
}
