import Image from "next/image";
import { cn } from "@/lib/utils";

/** Shared brand lockup for navigation and the footer. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[17px] leading-none font-semibold tracking-[-0.03em]", className)}>
      <Image src="/brand/bide-mark.png" alt="" width={28} height={28} className="size-7 shrink-0" />
      Bide
    </span>
  );
}
