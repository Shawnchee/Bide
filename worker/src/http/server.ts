// Hono HTTP: /health, /quotes/:asset, POST /desk/preview (shared secret). BUILD §4.4.
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { cfg, envReport } from "../config.js";
import type { Repo } from "../db/types.js";
import type { Desk, DeskResult } from "../desk/index.js";
import type { WorkerDeskTools } from "../desk-tools.js";
import { IntakeError, type IntakeService } from "../agents/intake.js";
import { loopHealthy, type LoopStats } from "../loops/scheduler.js";
const STARTED_AT = Date.now();
import { logger } from "../log.js";
import { rpcStats } from "../chain/rpc.js";
import type { Pricer, PricerAsset } from "../pricer/index.js";
import { nextFridayExpiry } from "../keeper/schedule.js";

const log = logger("http");

export interface HttpDeps {
  pricer: Pricer;
  repo: Repo;
  desk: Desk | null;
  deskTools: WorkerDeskTools;
  /** Intake agent (null when disabled / no Z.ai key). */
  intake?: IntakeService | null;
  loopStats: () => LoopStats[];
  status: () => Record<string, unknown>;
}

const u64 = z.string().regex(/^\d{1,20}$/);
const PreviewBody = z.object({
  asset: z.enum(["SOL", "BTC"]).default("SOL"),
  side: z.enum(["buy", "sell", "wheel"]),
  quick: z.boolean().default(false),
  target_strike: u64,
  exit_strike: u64.optional(),
  lock_strike: z.boolean().default(true),
  band: u64.optional(),
  exit_band: u64.optional(),
  size_total: u64,
  min_premium_bps_per_day: z.number().int().positive(),
  max_expiry_secs: z.number().int().positive(),
  horizon_end: z.number().int().positive(),
  max_rounds_per_day: z.number().int().positive().optional(),
  owner: z.string().optional(),
  patience: z.enum(["patient", "balanced", "eager"]).optional(),
});

export function secretOk(header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false; // fail closed when WORKER_SHARED_SECRET is EMPTY
  const got = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x)));

export function buildApp(d: HttpDeps) {
  const app = new Hono();

  app.get("/health", (c) => {
    const loops = d.loopStats();
    const ok = loops.every((l) => loopHealthy(l, Date.now(), STARTED_AT));
    return c.json({ ok, time: new Date().toISOString(), env: envReport(), repo: d.repo.backend, desk: !!d.desk, loops, rpc: rpcStats(), ...d.status() }, ok ? 200 : 503);
  });

  // GET /quotes/SOL?kind=put&strike=113&expiry=1791576000&size=1&quick=0  (strike $, expiry unix secs, size whole asset)
  app.get("/quotes/:asset", async (c) => {
    const asset = c.req.param("asset").toUpperCase() as PricerAsset;
    if (asset !== "SOL" && asset !== "BTC") return c.json({ error: "unknown asset" }, 404);
    const st = d.pricer.get(asset);
    const spot = st?.spot?.price;
    const q = c.req.query();
    const kind = (q.kind ?? "put") as "put" | "call";
    const now = Math.floor(Date.now() / 1000);
    const expiry = q.expiry ? Number(q.expiry) : nextFridayExpiry(now);
    const strike = q.strike ? Number(q.strike) : spot ? Math.round(spot * (kind === "put" ? 0.95 : 1.05)) : NaN;
    if (!Number.isFinite(strike) || !Number.isFinite(expiry)) return c.json({ error: "bad strike/expiry (or no spot yet)" }, 400);
    const r = await d.pricer.quote(asset, kind, strike, expiry * 1000, Number(q.size ?? 1), q.quick === "1");
    return c.json(jsonSafe({ asset, spot, venuesStatus: st?.snapshots.map((s) => ({ venue: s.venue, quotes: s.quotes.length, error: s.error })), quote: r }));
  });

  // POST /desk/preview — returns { desk_run_id } at once; steps stream into desk_runs. ?wait=1 returns the result.
  app.post("/desk/preview", async (c) => {
    if (!secretOk(c.req.header("authorization") ?? c.req.header("x-worker-secret"), cfg.workerSharedSecret)) return c.json({ error: "unauthorized" }, 401);
    if (!d.desk) return c.json({ error: "desk unavailable" }, 503);
    const parsed = PreviewBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const { patience, ...draft } = parsed.data;
    const planId = d.deskTools.registerDraft(draft);
    const runId = await d.repo.createDeskRun({ plan_pubkey: null, kind: "preview", status: "running" });
    const run = d.desk.runDesk({ plan_id: planId, kind: "preview", patience }, { onStep: (s) => d.repo.appendDeskStep(runId, s) })
      .then(async (r: DeskResult) => {
        await d.repo.updateDeskRun(runId, {
          steps: r.steps, proposal: r.memo.quant_proposal, verdict: r.memo.clef_answers, final: r.final, memo: JSON.parse(r.memo_json),
          memo_hash: r.memo_hash_hex, status: r.final.status, card: r.card,
        });
        return r;
      })
      .catch(async (e) => { log.error("preview failed", { err: e }); await d.repo.updateDeskRun(runId, { status: "error", error_code: (e as Error).message.slice(0, 200) }); throw e; });
    if (c.req.query("wait") === "1") {
      try {
        const r = await run;
        return c.json(jsonSafe({ desk_run_id: runId, final: r.final, card: r.card, memo_hash: r.memo_hash_hex }));
      } catch (e) { return c.json({ desk_run_id: runId, error: (e as Error).message }, 500); }
    }
    run.catch(() => {});
    return c.json({ desk_run_id: runId }, 202);
  });

  // POST /intake { text } → 202 { intake_id }; GET /intake/:id polls. GLM thinks for a while, so never block.
  app.post("/intake", async (c) => {
    if (!secretOk(c.req.header("authorization") ?? c.req.header("x-worker-secret"), cfg.workerSharedSecret)) return c.json({ error: "unauthorized" }, 401);
    if (!d.intake) return c.json({ error: "intake unavailable" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") return c.json({ error: "text is required" }, 400);
    try {
      const { id, done } = await d.intake.start(body.text);
      done.catch(() => {});
      return c.json({ intake_id: id }, 202);
    } catch (e) {
      if (e instanceof IntakeError) return c.json({ error: e.message }, e.status as 400 | 429);
      log.error("intake start failed", { err: e });
      return c.json({ error: "intake failed" }, 500);
    }
  });
  app.get("/intake/:id", async (c) => {
    if (!secretOk(c.req.header("authorization") ?? c.req.header("x-worker-secret"), cfg.workerSharedSecret)) return c.json({ error: "unauthorized" }, 401);
    if (!d.intake) return c.json({ error: "intake unavailable" }, 503);
    const r = await d.intake.get(c.req.param("id")).catch(() => null);
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/desk/runs/:id", async (c) => {
    const r = await d.repo.getDeskRun(c.req.param("id"));
    return r ? c.json(jsonSafe(r)) : c.json({ error: "not found" }, 404);
  });

  return app;
}
