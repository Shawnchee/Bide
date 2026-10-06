"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

export type TableState<T> =
  | { status: "unconfigured" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: T[] };

export interface TableQuery {
  table: string;
  select?: string;
  eq?: [string, string | number | boolean][];
  in?: [string, (string | number)[]];
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
  /** Realtime filter, e.g. "plan_pubkey=eq.<pk>". */
  realtimeFilter?: string;
  /** Fallback poll interval (ms) in case realtime isn't enabled on the table. */
  pollMs?: number;
  enabled?: boolean;
}

/** Read-only Supabase query with realtime + polling fallback. */
export function useTable<T>(q: TableQuery): TableState<T> & { reload: () => void } {
  const sb = getSupabase();
  const [state, setState] = useState<TableState<T>>(sb ? { status: "loading" } : { status: "unconfigured" });
  const key = JSON.stringify(q);

  const load = useCallback(async () => {
    const query = JSON.parse(key) as TableQuery;
    if (!sb || query.enabled === false) return;
    let req = sb.from(query.table).select(query.select ?? "*");
    for (const [c, v] of query.eq ?? []) req = req.eq(c, v);
    if (query.in) req = req.in(query.in[0], query.in[1]);
    if (query.orderBy) req = req.order(query.orderBy, { ascending: query.ascending ?? false });
    if (query.limit) req = req.limit(query.limit);
    const { data, error } = await req;
    if (error) setState({ status: "error", message: error.message });
    else setState({ status: "ready", rows: (data ?? []) as T[] });
  }, [sb, key]);

  useEffect(() => {
    if (!sb || q.enabled === false) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state is set after await
    load();
    const ch = sb
      .channel(`rt-${q.table}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: q.table, ...(q.realtimeFilter ? { filter: q.realtimeFilter } : {}) },
        () => load(),
      )
      .subscribe();
    const t = setInterval(load, q.pollMs ?? 15_000);
    return () => {
      clearInterval(t);
      sb.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb, key, load]);

  return { ...state, reload: load };
}
