import { WorkerError, workerFetch } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

/** Intake run status / result from the worker. */
export async function GET(_req: Request, ctx: RouteContext<"/api/intake/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  try {
    const res = await workerFetch(`/intake/${id}`, { timeoutMs: 5000 });
    const body = await res.json().catch(() => null);
    return Response.json(body ?? { error: "bad worker response" }, { status: res.ok ? 200 : res.status });
  } catch (e) {
    const err = e as WorkerError;
    return Response.json({ error: err.message }, { status: err.status ?? 502 });
  }
}
