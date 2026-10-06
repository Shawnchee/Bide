"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskRunRow, DeskStep } from "@/lib/types";

export interface DeskPreviewData {
  runId: string | null;
  steps: DeskStep[];
  final: { status?: string; proposal?: Record<string, unknown> | null; reason?: string } | null;
  memoHash: string | null;
  memo: Record<string, unknown> | null;
  card: Record<string, unknown> | null;
  status?: string | null;
  errorCode?: string | null;
}

export type DeskPreviewState =
  | { status: "idle" }
  | { status: "running"; data: DeskPreviewData }
  | { status: "done"; data: DeskPreviewData }
  | { status: "error"; message: string; data: DeskPreviewData | null };

const empty = (runId: string | null): DeskPreviewData => ({ runId, steps: [], final: null, memoHash: null, memo: null, card: null });

/** Normalise whatever the worker returns (a run id to follow, or a finished DeskResult). */
function fromBody(body: Record<string, unknown>): DeskPreviewData {
  const runId = (body.run_id ?? body.id ?? body.desk_run_id ?? null) as string | null;
  return {
    runId,
    steps: (body.steps as DeskStep[]) ?? [],
    final: (body.final as DeskPreviewData["final"]) ?? null,
    memoHash: (body.memo_hash_hex ?? body.memo_hash ?? null) as string | null,
    memo: (body.memo as Record<string, unknown>) ?? null,
    card: (body.card as Record<string, unknown>) ?? null,
  };
}

function fromRow(row: DeskRunRow): DeskPreviewData {
  return {
    runId: row.id,
    steps: row.steps ?? [],
    final: row.final,
    memoHash: row.memo_hash,
    memo: row.memo,
    card: (row.card as Record<string, unknown>) ?? null,
    status: row.status,
    errorCode: row.error_code,
  };
}

const GIVE_UP_MS = 240_000;

const isTerminal = (d: DeskPreviewData) => Boolean(d.final?.status) || d.status === "error";

/** Runs a desk preview through /api/desk/preview and streams steps from Supabase desk_runs. */
export function useDeskPreview() {
  const [state, setState] = useState<DeskPreviewState>({ status: "idle" });
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  /** Poll the worker's run record (steps are appended as the desk works). */
  const follow = useCallback((runId: string) => {
    const startedAt = Date.now();
    let stopped = false;
    let misses = 0;
    const stop = () => {
      stopped = true;
      clearInterval(t);
    };
    const poll = async () => {
      try {
        const res = await fetch(`/api/desk/runs/${runId}`, { cache: "no-store" });
        if (stopped) return;
        if (!res.ok) throw new Error(String(res.status));
        misses = 0;
        const d = fromRow((await res.json()) as DeskRunRow);
        setState(isTerminal(d) ? { status: "done", data: d } : { status: "running", data: d });
        if (isTerminal(d)) stop();
      } catch {
        if (++misses >= 5) {
          stop();
          setState((s) => ({ status: "error", message: "Lost contact with the desk. Try again.", data: "data" in s ? s.data : null }));
        }
      }
    };
    const t = setInterval(() => {
      // Runs take 50–100 s, plus queueing behind live keeper rounds (they always go first).
      if (Date.now() - startedAt > GIVE_UP_MS) {
        stop();
        setState((s) => ({
          status: "error",
          message: "The desk is busy with live rounds and hasn't reached your preview yet. Try again in a few minutes — you can still start the plan.",
          data: "data" in s ? s.data : null,
        }));
        return;
      }
      poll();
    }, 1200);
    stopRef.current = stop;
    poll();
  }, []);

  const run = useCallback(
    async (draft: Record<string, unknown>) => {
      stopRef.current?.();
      setState({ status: "running", data: empty(null) });
      try {
        const res = await fetch("/api/desk/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          const retry = Number(res.headers.get("retry-after") ?? body.retry_after ?? 0);
          const msg =
            res.status === 429
              ? `The desk is busy right now. Try again in ${retry > 0 ? `${Math.ceil(retry)}s` : "a minute"} — you can still review and start the plan.`
              : res.status === 503 || res.status === 502
              ? "The AI desk is offline right now, so there's no live quote. You can still review and start the plan — the desk prices each round when it opens."
              : (body.error as string) || "The desk couldn't price this plan.";
          setState({ status: "error", message: msg, data: null });
          return;
        }
        const d = fromBody(body);
        if (isTerminal(d)) setState({ status: "done", data: d });
        else if (d.runId) {
          setState({ status: "running", data: d });
          follow(d.runId);
        } else setState({ status: "error", message: "The desk returned an empty answer.", data: d });
      } catch {
        setState({ status: "error", message: "Couldn't reach the desk. Check your connection and try again.", data: null });
      }
    },
    [follow],
  );

  const reset = useCallback(() => {
    stopRef.current?.();
    setState({ status: "idle" });
  }, []);

  return { state, run, reset };
}
