import { WorkerError, workerFetch } from "@/lib/server/worker";
import { checkPreviewDraft, clientIp, relay } from "../../_lib/guard";

export const dynamic = "force-dynamic";

/** Forwards a draft plan to the worker's desk preview. Strictly validated here and again (authoritatively) on the worker. */
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const checked = checkPreviewDraft(raw);
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  const ip = clientIp(req);
  try {
    const res = await workerFetch("/desk/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "X-Client-IP": ip } : {}) },
      body: JSON.stringify(checked.draft),
      timeoutMs: 15000,
    });
    return relay(res);
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
