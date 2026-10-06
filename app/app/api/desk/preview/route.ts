import { WorkerError, workerFetch } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS = [
  "asset",
  "side",
  "quick",
  "target_strike",
  "exit_strike",
  "size_total",
  "lock_strike",
  "min_premium_bps_per_day",
  "max_expiry_secs",
  "horizon_end",
  "patience",
  "band",
  "exit_band",
  "max_rounds_per_day",
  "owner",
] as const;

/** Forwards a draft plan to the worker's desk preview. Only whitelisted fields pass through. */
export async function POST(req: Request) {
  let raw: Record<string, unknown>;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const draft: Record<string, unknown> = {};
  for (const k of ALLOWED_KEYS) if (k in raw) draft[k] = raw[k];
  if (typeof draft.asset !== "string" || typeof draft.side !== "string" || typeof draft.target_strike !== "string") {
    return Response.json({ error: "asset, side and target_strike are required" }, { status: 400 });
  }
  try {
    const res = await workerFetch("/desk/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
      timeoutMs: 15000,
    });
    const body = await res.json().catch(() => null);
    return Response.json(body ?? { error: "bad worker response" }, { status: res.ok ? 200 : res.status });
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
