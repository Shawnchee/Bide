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
const POLL_MS = 1_200;
/** Per-request client timeouts: the routes give up on the worker at 15 s / 5 s, these are a backstop. */
const POST_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 8_000;
/** Consecutive failed polls before we call the desk unreachable (~10–40 s depending on how they fail). */
const MAX_MISSES = 4;

export const UNREACHABLE = "Can't reach the desk right now — you can still review and start the plan.";

/** fetch that aborts on `parent` or after `ms` (manual, for browsers without AbortSignal.any). */
async function fetchWithin(url: string, init: RequestInit, parent: AbortSignal, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  parent.addEventListener("abort", onAbort);
  const t = setTimeout(onAbort, ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    parent.removeEventListener("abort", onAbort);
  }
}

const isTerminal = (d: DeskPreviewData) => Boolean(d.final?.status) || d.status === "error";

/** Runs a desk preview through /api/desk/preview and streams steps from the worker's run record. Never spins forever:
 * a failed POST, MAX_MISSES failed polls in a row, a lost run, or GIVE_UP_MS all end in an error state the UI can retry. */
export function useDeskPreview() {
  const [state, setState] = useState<DeskPreviewState>({ status: "idle" });
  const stopRef = useRef<(() => void) | null>(null);
  const lastDraft = useRef<Record<string, unknown> | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  /** Poll the worker's run record (steps are appended as the desk works). One request in flight at a time. */
  const follow = useCallback((runId: string) => {
    const startedAt = Date.now();
    let stopped = false;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
    const fail = (message: string) => {
      stop();
      setState((s) => ({ status: "error", message, data: "data" in s ? s.data : null }));
    };
    const poll = async () => {
      if (stopped) return;
      // Runs take 50–100 s, plus queueing behind live keeper rounds (they always go first).
      if (Date.now() - startedAt > GIVE_UP_MS)
        return fail("The desk is busy with live rounds and hasn't reached your preview yet. Try again in a few minutes — you can still start the plan.");
      try {
        const res = await fetchWithin(`/api/desk/runs/${runId}`, { cache: "no-store" }, ctrl.signal, POLL_TIMEOUT_MS);
        if (stopped) return;
        // The run is gone (e.g. the worker restarted): polling again won't bring it back.
        if (res.status === 404) return fail("The desk lost this preview. Try again — you can still review and start the plan.");
        if (!res.ok) throw new Error(String(res.status));
        misses = 0;
        const d = fromRow((await res.json()) as DeskRunRow);
        if (stopped) return;
        setState(isTerminal(d) ? { status: "done", data: d } : { status: "running", data: d });
        if (isTerminal(d)) return stop();
      } catch {
        if (stopped) return;
        if (++misses >= MAX_MISSES) return fail(UNREACHABLE);
      }
      timer = setTimeout(poll, POLL_MS);
    };
    stopRef.current = stop;
    void poll();
  }, []);

  const run = useCallback(
    async (draft: Record<string, unknown>) => {
      stopRef.current?.();
      lastDraft.current = draft;
      const ctrl = new AbortController();
      let stopped = false;
      stopRef.current = () => {
        stopped = true;
        ctrl.abort();
      };
      setState({ status: "running", data: empty(null) });
      try {
        const res = await fetchWithin(
          "/api/desk/preview",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) },
          ctrl.signal,
          POST_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (stopped) return;
        if (!res.ok) {
          const retry = Number(res.headers.get("retry-after") ?? body.retry_after ?? 0);
          const msg =
            res.status === 429
              ? `The desk is busy right now. Try again in ${retry > 0 ? `${Math.ceil(retry)}s` : "a minute"} — you can still review and start the plan.`
              : res.status >= 500
                ? UNREACHABLE
                : (body.error as string) || "The desk couldn't price this plan.";
          setState({ status: "error", message: msg, data: null });
          return;
        }
        const d = fromBody(body);
        if (isTerminal(d)) setState({ status: "done", data: d });
        else if (d.runId) {
          setState({ status: "running", data: d });
          follow(d.runId);
        } else setState({ status: "error", message: "The desk returned an empty answer. Try again — you can still review and start the plan.", data: d });
      } catch {
        if (!stopped) setState({ status: "error", message: UNREACHABLE, data: null });
      }
    },
    [follow],
  );

  /** Re-run the last draft (the Retry button). */
  const retry = useCallback(() => {
    if (lastDraft.current) void run(lastDraft.current);
  }, [run]);

  const reset = useCallback(() => {
    stopRef.current?.();
    setState({ status: "idle" });
  }, []);

  return { state, run, retry, reset };
}
