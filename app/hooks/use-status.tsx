"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { SUPABASE_CONFIGURED } from "@/lib/env";

export interface WorkerHealth {
  configured: boolean;
  ok: boolean;
  checkedAt: number;
  error?: string;
  worker?: unknown;
}

interface StatusValue {
  health: WorkerHealth | null;
  dataConfigured: boolean;
  refresh: () => void;
}

const StatusCtx = createContext<StatusValue>({ health: null, dataConfigured: SUPABASE_CONFIGURED, refresh: () => {} });

export function StatusProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<WorkerHealth | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth({ configured: true, ok: false, checkedAt: Date.now(), error: "unreachable" });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial poll
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  return <StatusCtx.Provider value={{ health, dataConfigured: SUPABASE_CONFIGURED, refresh }}>{children}</StatusCtx.Provider>;
}

export const useStatus = () => useContext(StatusCtx);
