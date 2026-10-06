import { WorkerError, workerFetch } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/quotes/[asset]">) {
  const { asset } = await ctx.params;
  if (!/^(SOL|BTC)$/i.test(asset)) return Response.json({ error: "unknown asset" }, { status: 400 });
  try {
    const res = await workerFetch(`/quotes/${asset.toUpperCase()}`, { timeoutMs: 6000 });
    const body = await res.json().catch(() => null);
    return Response.json(body ?? { error: "bad worker response" }, { status: res.ok ? 200 : res.status });
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
