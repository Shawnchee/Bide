"use client";

import { CloudOff, DatabaseZap } from "lucide-react";
import { useStatus } from "@/hooks/use-status";

/** Global banners: worker offline, data feed not configured. Honest, never blocking. */
export function StatusBanner() {
  const { health, dataConfigured } = useStatus();
  const workerDown = health !== null && !health.ok;
  if (!workerDown && dataConfigured) return null;
  return (
    <div className="border-b border-border bg-warning-soft text-warning-foreground" role="status">
      <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-2 text-xs sm:px-6">
        {workerDown && (
          <p className="flex items-center gap-2">
            <CloudOff className="size-4 shrink-0" aria-hidden />
            {health?.configured === false
              ? "Worker not connected — live quotes and the AI desk are unavailable. Showing last recorded rounds."
              : "Worker offline — showing last recorded rounds. Your funds stay safe on-chain either way."}
          </p>
        )}
        {!dataConfigured && (
          <p className="flex items-center gap-2">
            <DatabaseZap className="size-4 shrink-0" aria-hidden />
            Data feed not configured — desk history, rounds and auctions can&apos;t be shown yet.
          </p>
        )}
      </div>
    </div>
  );
}
