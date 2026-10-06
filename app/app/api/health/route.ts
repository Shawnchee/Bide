import { workerConfigured, workerFetch } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!workerConfigured()) {
    return Response.json({ configured: false, ok: false, checkedAt: Date.now() });
  }
  try {
    const res = await workerFetch("/health", { timeoutMs: 4000 });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return Response.json({ configured: true, ok: res.ok, status: res.status, worker: body, checkedAt: Date.now() });
  } catch (e) {
    return Response.json({ configured: true, ok: false, error: (e as Error).message, checkedAt: Date.now() });
  }
}
