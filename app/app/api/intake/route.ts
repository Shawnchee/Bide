import { WorkerError, workerFetch } from "@/lib/server/worker";
import { INTAKE_MAX_TEXT, cleanIntakeText, clientIp, relay } from "../_lib/guard";

export const dynamic = "force-dynamic";

/** Starts an intake run on the worker (returns 202 { intake_id } at once; poll /api/intake/[id]). Text only. */
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const r = raw as { text?: unknown } | null;
  if (!r || typeof r !== "object" || Object.keys(r).some((k) => k !== "text")) return Response.json({ error: "only text is accepted" }, { status: 400 });
  if (typeof r.text !== "string" || r.text.length > 4 * INTAKE_MAX_TEXT) return Response.json({ error: "text is required" }, { status: 400 });
  const text = cleanIntakeText(r.text);
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });
  if (text.length > INTAKE_MAX_TEXT) return Response.json({ error: `keep it under ${INTAKE_MAX_TEXT} characters` }, { status: 400 });
  const ip = clientIp(req);
  try {
    const res = await workerFetch("/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "X-Client-IP": ip } : {}) },
      body: JSON.stringify({ text }),
      timeoutMs: 10_000,
    });
    return relay(res);
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
