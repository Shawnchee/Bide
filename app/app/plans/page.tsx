import type { Metadata } from "next";
import { PageHeader } from "@/components/site/bits";
import { MyPlans } from "@/components/plan/my-plans";

export const metadata: Metadata = { title: "My plans" };

export default function PlansPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <PageHeader eyebrow="Your wallet" title="My plans" />
      <MyPlans />
    </div>
  );
}
