import { WorkerError, workerFetch } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

/** Starts an intake run on the worker (returns 202 { intake_id } at once; poll /api/intake/[id]). Text only. */
export async function POST(req: Request) {
  let raw: { text?: unknown };
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof raw.text !== "string" || !raw.text.trim()) return Response.json({ error: "text is required" }, { status: 400 });
  if (raw.text.length > 600) return Response.json({ error: "keep it under 600 characters" }, { status: 400 });
  try {
    const res = await workerFetch("/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: raw.text }),
      timeoutMs: 10_000,
    });
    const body = await res.json().catch(() => null);
    return Response.json(body ?? { error: "bad worker response" }, { status: res.status });
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
