import { WorkerError, workerFetch } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

/** Optional pricing inputs forwarded to the worker: kind=put|call, strike (dollars), expiry (unix s), quick=1. */
function forwardQuery(url: URL): string {
  const q = url.searchParams;
  const out = new URLSearchParams();
  const kind = q.get("kind");
  if (kind === "put" || kind === "call") out.set("kind", kind);
  const strike = Number(q.get("strike"));
  if (q.has("strike") && Number.isFinite(strike) && strike > 0 && strike < 1e7) out.set("strike", String(strike));
  const expiry = Number(q.get("expiry"));
  if (q.has("expiry") && Number.isInteger(expiry) && expiry > 0) out.set("expiry", String(expiry));
  if (q.get("quick") === "1") out.set("quick", "1");
  const s = out.toString();
  return s ? `?${s}` : "";
}

export async function GET(req: Request, ctx: RouteContext<"/api/quotes/[asset]">) {
  const { asset } = await ctx.params;
  if (!/^(SOL|BTC)$/i.test(asset)) return Response.json({ error: "unknown asset" }, { status: 400 });
  try {
    const res = await workerFetch(`/quotes/${asset.toUpperCase()}${forwardQuery(new URL(req.url))}`, { timeoutMs: 6000 });
    const body = await res.json().catch(() => null);
    return Response.json(body ?? { error: "bad worker response" }, { status: res.ok ? 200 : res.status });
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
