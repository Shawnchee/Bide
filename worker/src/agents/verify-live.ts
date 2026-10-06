/**
 * Live smoke for the AI agents v2 (run with keys in .env):
 *   pnpm --filter @bide/worker exec tsx src/agents/verify-live.ts [maker|intake|desk]...   (default: maker intake)
 * maker  — real pricer + Pyth + one GLM stance call per persona for the next Friday std epoch (SOL puts).
 * intake — one intake run on a sample sentence.
 * desk   — one desk preview on a draft plan (checks the Quant calls recent_outcomes and cites it). Several GLM calls.
 * Prints env as NAME=SET/EMPTY and the parsed results only — never a key or a URL.
 */
import "../config.js"; // loads .env
import { readDeskConfig, describeDeskEnv } from "../desk/config.js";
import { createZaiTransport } from "../desk/llm/chat.js";
import { createDeskFromEnv } from "../desk/orchestrator.js";
import { Pricer } from "../pricer/index.js";
import { JupiterReference } from "../jupiter/reference.js";
import { WorkerDeskTools } from "../desk-tools.js";
import { MemoryRepo } from "../db/memory.js";
import { nextFridayExpiry } from "../keeper/schedule.js";
import type { AssetState, EpochState } from "../chain/types.js";
import { readAgentConfig, describeAgentEnv } from "./config.js";
import { LlmQueue, PRIORITY } from "./queue.js";
import { MakerAgents } from "./maker/service.js";
import { decideStance, bidFromStance } from "./maker/stance.js";
import { PERSONAS } from "./maker/personas.js";
import { IntakeService } from "./intake.js";

const which = process.argv.slice(2).length ? process.argv.slice(2) : ["maker", "intake"];
const desk = readDeskConfig();
const agents = readAgentConfig();
console.log("env:", describeDeskEnv(), "|", describeAgentEnv());
console.log("model:", agents.model, "makerLlm:", agents.makerLlm, "intake:", agents.intakeEnabled);
if (!desk.zai.apiKey) { console.log("ZAI_API_KEY EMPTY — nothing to do"); process.exit(1); }

const queue = new LlmQueue();
const zai = createZaiTransport({ apiKey: desk.zai.apiKey, baseUrl: desk.zai.baseUrl, timeoutMs: desk.zai.timeoutMs });
const repo = new MemoryRepo();
const pricer = new Pricer(["SOL"]);
const tools = new WorkerDeskTools({ pricer, jupiter: new JupiterReference(repo), chain: null, getSnapshot: async () => null });
tools.setOutcomeSource(repo, () => ({}));

if (which.includes("maker")) {
  await pricer.refreshAll();
  const now = Math.floor(Date.now() / 1000);
  const asset: AssetState = { pubkey: "SOL-ASSET", mint: "So11111111111111111111111111111111111111112", decimals: 9, pythFeedId: "", strikeTick: 100_000n, maxConfBps: 0, maxSpotMoveBps: 0, maxSpotAgeSecs: 60, enabled: true, symbol: "SOL" };
  const expiry = nextFridayExpiry(now);
  const epoch: EpochState = { pubkey: "FRIDAY-EPOCH", asset: asset.pubkey, kind: "Std", expiry, nBuckets: 0, bucketSecs: 0, bucketToleranceSecs: 0, samples: [], sampleMask: 0, settlePrice: 0n, status: "Open" };
  const svc = new MakerAgents({ repo, transport: queue.wrap(zai, PRIORITY.maker), model: agents.model, cfg: agents, tools, makers: PERSONAS.map((p) => ({ name: p.maker, pubkey: p.maker })), inventory: async () => null });
  for (const p of PERSONAS) {
    const ctx = await svc.context({ now, assets: [asset], epochs: [epoch] } as any, asset, epoch, "put", p.maker);
    const t0 = Date.now();
    const d = await decideStance({ transport: queue.wrap(zai, PRIORITY.maker), model: agents.model, persona: p, ctx, timeoutMs: agents.makerTimeoutMs });
    console.log(`\n[maker ${p.maker} · ${p.title}] ${Date.now() - t0} ms`);
    console.log(" inputs:", JSON.stringify({ spot: ctx.spot, moves: ctx.spot_moves, grid: ctx.price_grid, dispersion: ctx.venue_dispersion, events: ctx.events.map((e) => `${e.kind}@${e.at_utc} inside=${e.inside_option_life}`) }));
    console.log(" decision:", JSON.stringify(d));
    const cell = ctx.price_grid.find((c) => c.fair_usd !== null);
    if (cell && d.source === "llm") {
      const fair = BigInt(Math.round(cell.fair_usd! * 1e6));
      const b = bidFromStance(d.stance, d.spread_pct, fair, (fair * 70n) / 100n, (fair * 130n) / 100n);
      console.log(` example round (strike $${cell.strike_usd}, 1 SOL, fair $${cell.fair_usd}, floor 0.7×, start 1.3×) → bid`, b.bid === null ? "none" : `$${Number(b.bid) / 1e6}`, b.note ?? "");
    }
  }
}

if (which.includes("intake")) {
  if (!pricer.get("SOL")?.spot) await pricer.refresh("SOL");
  const svc = new IntakeService({ repo, transport: queue.wrap(zai, PRIORITY.intake), model: agents.model, timeoutMs: agents.intakeTimeoutMs, maxPerMinute: 5, spot: () => pricer.get("SOL")?.spot?.price ?? null });
  const text = "I'd like to buy around $300 worth of SOL if it dips about 8 bucks below today's price, sometime in the next few weeks. I'm not in a hurry.";
  const t0 = Date.now();
  const { id, done } = await svc.start(text);
  await done;
  console.log(`\n[intake] ${Date.now() - t0} ms · spot $${pricer.get("SOL")?.spot?.price?.toFixed(2)}`);
  console.log(" text:", text);
  console.log(" result:", JSON.stringify(await svc.get(id), null, 1));
}

if (which.includes("desk")) {
  await pricer.refreshAll();
  const spot = pricer.get("SOL")!.spot!.price;
  const now = Math.floor(Date.now() / 1000);
  const planId = tools.registerDraft({ asset: "SOL", side: "buy", quick: false, target_strike: String(Math.floor(spot * 0.93) * 1_000_000), lock_strike: true, size_total: "1500000000", min_premium_bps_per_day: 10, max_expiry_secs: 30 * 86_400, horizon_end: now + 30 * 86_400 });
  const d = createDeskFromEnv(tools, process.env, desk, (t) => queue.wrap(t, PRIORITY.desk));
  const t0 = Date.now();
  const r = await d.runDesk({ plan_id: planId, kind: "preview", patience: "balanced" });
  console.log(`\n[desk preview] ${Date.now() - t0} ms · status ${r.final.status}`);
  console.log(" tools called:", r.memo.tool_traces.map((t) => `${t.name}${t.ok ? "" : "(err)"}`).join(", "));
  console.log(" rationale:", r.final.proposal?.rationale);
  console.log(" outcomes_cited:", r.memo.outcomes_cited, "| risk:", JSON.stringify(r.memo.clef_answers.map((c) => c.binding.verdict)));
}
console.log("\nqueue:", JSON.stringify(queue.stats));
process.exit(0);
