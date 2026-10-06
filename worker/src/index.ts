// bide-worker entrypoint: pricer, Jupiter reference, keeper, makers, mirror, notify, HTTP.
import { serve } from "@hono/node-server";
import { PublicKey } from "@solana/web3.js";
import { cfg, envReport } from "./config.js";
import { loadAnchorChain } from "./chain/anchor.js";
import type { BideChain } from "./chain/client.js";
import { loadKeypair, loadMakerKeypairs } from "./chain/keypairs.js";
import { SnapshotCache } from "./chain/snapshot-cache.js";
import { initRepo } from "./db/index.js";
import { createDeskFromEnv, createZaiTransport, readDeskConfig, type Desk } from "./desk/index.js";
import { describeAgentEnv, readAgentConfig } from "./agents/config.js";
import { LlmQueue, PRIORITY } from "./agents/queue.js";
import { MakerAgents } from "./agents/maker/service.js";
import { makerPnl } from "./agents/outcomes.js";
import { IntakeService } from "./agents/intake.js";
import { WorkerDeskTools } from "./desk-tools.js";
import { buildApp } from "./http/server.js";
import { JupiterReference } from "./jupiter/reference.js";
import { Keeper } from "./keeper/index.js";
import { Sampler } from "./keeper/sampler.js";
import { nextFridayExpiry } from "./keeper/schedule.js";
import { logger } from "./log.js";
import { Mirror } from "./loops/mirror.js";
import { Scheduler } from "./loops/scheduler.js";
import { Makers } from "./makers/index.js";
import { topUpWsol } from "./makers/wsol.js";
import { Notifier } from "./notify/telegram.js";
import { Pricer } from "./pricer/index.js";

const log = logger("main");
log.info("starting bide-worker", { env: envReport(), rpc: new URL(cfg.rpcUrl).host });

const repo = await initRepo();
const pricer = new Pricer(["SOL"]);
const jupiter = new JupiterReference(repo);
const snapshots = new SnapshotCache(null);
let chain: BideChain | null = null;
let chainStatus = "not loaded";

const deskTools = new WorkerDeskTools({ pricer, jupiter, chain: null, getSnapshot: () => snapshots.get().catch(() => snapshots.peek()) });
// AI agents v2: every GLM call (desk, intake, maker stances) goes through one serial queue (desk first).
const agentCfg = readAgentConfig();
const deskCfg = readDeskConfig();
const llmQueue = new LlmQueue();
const zai = createZaiTransport({ apiKey: deskCfg.zai.apiKey, baseUrl: deskCfg.zai.baseUrl, timeoutMs: deskCfg.zai.timeoutMs });
log.info("agents", { env: describeAgentEnv(), makerLlm: agentCfg.makerLlm, intake: agentCfg.intakeEnabled, model: agentCfg.model });
let makerNames: Record<string, string> = {};
deskTools.setOutcomeSource(repo, () => makerNames);
let desk: Desk | null = null;
try { desk = createDeskFromEnv(deskTools, process.env, deskCfg, (t) => llmQueue.wrap(t, PRIORITY.desk)); } catch (e) { log.warn("desk unavailable", { err: (e as Error).message }); }

const notifier = new Notifier(repo, async (plan) => (await snapshots.get().catch(() => null))?.plans.find((p) => p.pubkey === plan)?.owner ?? null);
const sched = new Scheduler();

// Pricer every 10 s; write a reference quote row (SOL put spot−5%, next Friday) every 60 s.
let lastQuoteWrite = 0;
sched.add("pricer", 10_000, async () => {
  await pricer.refreshAll();
  if (Date.now() - lastQuoteWrite < 60_000) return;
  const spot = pricer.get("SOL")?.spot?.price;
  if (!spot) return;
  const strike = Math.round(spot * 0.95);
  const expiry = nextFridayExpiry(Math.floor(Date.now() / 1000));
  const r = await pricer.quote("SOL", "put", strike, expiry * 1000, 1, false);
  lastQuoteWrite = Date.now();
  await repo.insertQuote({
    asset: "SOL", fair_iv: r.ok ? r.fairIv : null, bid_iv: r.ok ? r.bidIv : null, quick_pricing: r.ok ? r.quick_pricing : false,
    venues: r.ok ? r.venues : r.rejected, kind: "put", strike: String(strike * 1e6), expiry: new Date(expiry * 1000).toISOString(), spot,
    ...(r.ok ? { fair_premium: String(r.fairPremium), bid_premium: String(r.bidPremium), premium_start: String(r.start), premium_floor: String(r.floor) } : {}),
  });
}, { watchdogMs: 60_000 });
sched.add("jupiter", 60_000, async () => { await jupiter.refresh(); }, { initialDelayMs: 3_000 });
if (notifier.enabled) sched.add("telegram", 1_000, () => notifier.pollOnce());

// Chain-dependent loops start once PROGRAM_ID + IDL are available (re-checked every 60 s).
let chainLoopsStarted = false;
async function tryStartChain() {
  if (chainLoopsStarted) return;
  try {
    chain = await loadAnchorChain("snapshot");
    await chain.snapshot(); // fails if Config isn't initialised yet
  } catch (e) {
    chainStatus = (e as Error).message;
    chain = null;
    return;
  }
  chainStatus = "live";
  snapshots.setChain(chain);
  deskTools.setChain(chain);
  chainLoopsStarted = true;
  log.info("chain live", { programId: chain.programId.toBase58() });
  sched.add("mirror", 15_000, () => mirror.tick());
  // Each write loop gets its own Connection (chain/rpc.ts): a stuck socket in one loop never blocks another.
  const keeperKp = loadKeypair("KEEPER_KEYPAIR");
  if (cfg.enableKeeper && keeperKp) {
    const [keeperChain, samplerChain] = await Promise.all([loadAnchorChain("keeper"), loadAnchorChain("sampler")]);
    const keeper = new Keeper({ chain: keeperChain, snapshots, signer: keeperKp, repo, desk, quickEnabled: cfg.quickPlansEnabled, skipSampling: true });
    sched.add("keeper", 3_000, () => keeper.tick());
    const sampler = new Sampler({ chain: samplerChain, signer: keeperKp });
    sched.add("sampler", 1_000, async () => { await sampler.tick(); }, { watchdogMs: 10_000, maxBackoffMs: 2_000 });
    log.info("keeper on", { agent: keeperKp.publicKey.toBase58(), desk: !!desk, sampler: true });
  } else log.warn("keeper off", { enableKeeper: cfg.enableKeeper, KEEPER_KEYPAIR: keeperKp ? "SET" : "EMPTY" });
  const makerKeys = loadMakerKeypairs();
  if (cfg.enableMakers && makerKeys.length) {
    const makersChain = await loadAnchorChain("makers");
    for (const m of makerKeys) await topUpWsol(makersChain.connection, m.kp, m.name).catch((e) => log.warn("wsol top-up failed", { maker: m.name, err: (e as Error).message }));
    const makers = new Makers(makersChain, snapshots, pricer, makerKeys, new PublicKey(cfg.usdcMint), { repo });
    makerNames = Object.fromEntries(makers.botKeys.map((b) => [b.pubkey, b.name]));
    if (agentCfg.makerLlm) {
      const agents = new MakerAgents({
        repo, transport: llmQueue.wrap(zai, PRIORITY.maker), model: agentCfg.model, cfg: agentCfg, tools: deskTools, makers: makers.botKeys,
        inventory: (name, s, asset) => makers.inventoryFor(name, s, asset),
      });
      makers.setAgents(agents);
      sched.add("maker-stances", 15_000, async () => { const s = await snapshots.get(); if (s) agents.tick(s); });
    }
    sched.add("makers", 2_000, () => makers.tick());
  } else log.warn("makers off", { enableMakers: cfg.enableMakers, count: makerKeys.length });
}
// Maker P&L ledger: settlement value − premium paid, written when a maker-taken round resolves.
const mirror = new Mirror(snapshots, repo, (e) => notifier.notify(e), async (o) => {
  const r = o.round;
  const pnl = makerPnl({ kind: r.kind, strike: r.strike, size: r.size, settlePrice: o.settlePrice, exercised: o.exercised, premiumPaid: r.premiumPaid }, o.assetDecimals);
  await repo.setMakerBidPnl(r.pubkey, r.maker!, pnl.toString());
  log.info("maker pnl", { round: r.pubkey, maker: r.maker, exercised: o.exercised, pnl: pnl.toString() });
});
sched.add("chain-init", 60_000, async () => { await tryStartChain(); if (chainLoopsStarted) return; log.info("chain not ready", { reason: chainStatus }); });

const intake = agentCfg.intakeEnabled
  ? new IntakeService({ repo, transport: llmQueue.wrap(zai, PRIORITY.intake), model: agentCfg.model, timeoutMs: agentCfg.intakeTimeoutMs, maxPerMinute: agentCfg.intakeMaxPerMinute, quickEnabled: cfg.quickPlansEnabled, spot: () => pricer.get("SOL")?.spot?.price ?? null })
  : null;
const app = buildApp({ pricer, repo, desk, deskTools, intake, loopStats: () => sched.stats(), status: () => ({ chain: chainStatus, telegram: notifier.enabled, agents: { makerLlm: agentCfg.makerLlm, intake: !!intake, llmQueue: llmQueue.stats } }) });
serve({ fetch: app.fetch, port: cfg.port, hostname: process.env.HOST ?? "127.0.0.1" }, (i) => log.info("http listening", { port: i.port }));

// Host-suspension detector: on a laptop, sleep freezes every timer (run #2 saw a 5-min clamshell sleep mid-loop).
// A 5 s heartbeat that fires > 20 s late means the process was suspended or the event loop was blocked.
let beat = Date.now();
setInterval(() => {
  const late = Date.now() - beat - 5_000;
  if (late > 20_000) log.error("process suspended or event loop blocked", { lateS: Math.round(late / 1000) });
  beat = Date.now();
}, 5_000).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { log.info("shutdown", { sig }); sched.stop(); process.exit(0); });
process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: e }));
