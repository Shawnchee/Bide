import "server-only";

// Server-side only: the shared secret never reaches the browser.
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.WORKER_SHARED_SECRET || "";

export const workerConfigured = () => Boolean(WORKER_URL);

export class WorkerError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function workerFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  if (!WORKER_URL) throw new WorkerError("worker not configured", 503);
  const { timeoutMs = 8000, headers, ...rest } = init;
  const h = new Headers(headers);
  if (SECRET) {
    h.set("Authorization", `Bearer ${SECRET}`);
  }
  try {
    return await fetch(`${WORKER_URL}${path}`, {
      ...rest,
      headers: h,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "worker timed out" : "worker unreachable";
    throw new WorkerError(msg, 502);
  }
}
