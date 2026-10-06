// Integration run #2 robustness: RPC timeout + fallback, sender re-send/expiry, scheduler watchdog, sampler timing.
// Test doubles are local (an in-process HTTP server for the RPC, plain objects for chain/connection); product code has no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import { makeRpcFetch } from "../src/chain/rpc.js";
import { sendAndConfirm, TxExpiredError, TxFailedError } from "../src/chain/send.js";
import { Scheduler, loopHealthy } from "../src/loops/scheduler.js";
import { dueSamples, samplingActive, Sampler, SAMPLE_POST_DELAY_SECS } from "../src/keeper/sampler.js";
import { bucketStart, windowStart } from "../src/keeper/schedule.js";
import type { EpochState, RoundState, AssetState } from "../src/chain/types.js";

// ---------------- RPC fetch wrapper ----------------
function hangingFetch(calls: string[]) {
  return (url: string, init: any) => {
    calls.push(url);
    return new Promise<Response>((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  };
}

test("rpc fetch: primary hang → aborted at the timeout, fallback answers", async () => {
  const calls: string[] = [];
  const hang = hangingFetch(calls);
  const f = makeRpcFetch({
    primary: "P", fallback: "F", timeoutMs: 150, label: "t1",
    fetchImpl: (url: string, init: any) => (url === "P" ? hang(url, init) : (calls.push(url), Promise.resolve(new Response("ok", { status: 200 })))),
  });
  const t0 = Date.now();
  const res = await f("P", { method: "POST", body: "{}" });
  assert.equal(await res.text(), "ok");
  assert.deepEqual(calls, ["P", "F"]);
  assert.ok(Date.now() - t0 < 1_000, "bounded by the timeout, not undici's 300 s");
});

test("rpc fetch: 5xx and 429 fall back; 200 and 4xx do not", async () => {
  for (const [status, expect] of [[503, ["P", "F"]], [429, ["P", "F"]], [200, ["P"]], [400, ["P"]]] as const) {
    const calls: string[] = [];
    const f = makeRpcFetch({
      primary: "P", fallback: "F", timeoutMs: 1_000, label: `t-${status}`,
      fetchImpl: async (url: string) => { calls.push(url); return new Response("x", { status: url === "P" ? status : 200 }); },
    });
    await f("P", {});
    assert.deepEqual(calls, expect, `status ${status}`);
  }
});

test("rpc fetch: both endpoints hang → plain Error within ~2× timeout; no fallback → plain Error", async () => {
  const calls: string[] = [];
  const f = makeRpcFetch({ primary: "P", fallback: "F", timeoutMs: 100, label: "t3", fetchImpl: hangingFetch(calls) as any });
  const t0 = Date.now();
  await assert.rejects(f("P", {}), (e: any) => e instanceof Error && /primary timeout, fallback timeout/.test(e.message));
  assert.ok(Date.now() - t0 < 1_000);
  const g = makeRpcFetch({ primary: "P", timeoutMs: 100, label: "t4", fetchImpl: hangingFetch([]) as any });
  await assert.rejects(g("P", {}), (e: any) => e instanceof Error && /primary timeout/.test(e.message));
});

async function listen(handler: (body: any, res: any) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(JSON.parse(b), res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("web3.js Connection with the wrapper: hanging primary server → getSlot answered by fallback", async () => {
  const hang = await listen(() => { /* never responds */ });
  const ok = await listen((body, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 4242 })); });
  try {
    const conn = new Connection(hang.url, { fetch: makeRpcFetch({ primary: hang.url, fallback: ok.url, timeoutMs: 200, label: "t5" }) as any, disableRetryOnRateLimit: true });
    const t0 = Date.now();
    assert.equal(await conn.getSlot(), 4242);
    assert.ok(Date.now() - t0 < 2_000);
  } finally { hang.server.closeAllConnections(); hang.server.close(); ok.server.close(); }
});

// ---------------- sender ----------------
function fakeConn(o: { landAfterPolls?: number; err?: unknown; heights?: number[]; failFirstSend?: boolean }) {
  let polls = 0; let sends = 0; let h = 0;
  const conn: any = {
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
    sendRawTransaction: async () => { sends++; if (o.failFirstSend && sends === 1) throw new Error("fetch failed"); return "sig"; },
    getSignatureStatuses: async () => {
      polls++;
      const landed = o.landAfterPolls !== undefined && polls >= o.landAfterPolls;
      return { value: [landed ? { confirmationStatus: "confirmed", err: o.err ?? null } : null] };
    },
    getBlockHeight: async () => (o.heights ? o.heights[Math.min(h++, o.heights.length - 1)] : 50),
    getTransaction: async () => ({ meta: { logMessages: ["Program log: AnchorError Error Code: BucketFilled. Error Number: 6030."] } }),
  };
  return { conn, sends: () => sends };
}
const payer = Keypair.generate();
const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 });

test("sender: re-sends the same tx until confirmed (first send network error tolerated)", async () => {
  const f = fakeConn({ landAfterPolls: 4, failFirstSend: true });
  const sig = await sendAndConfirm(f.conn, payer, [ix], [], { pollMs: 0, resendMs: 0, sleep: async () => {} });
  assert.equal(typeof sig, "string");
  assert.ok(f.sends() >= 3, `re-sent (${f.sends()} sends)`);
});

test("sender: landed-but-failed → TxFailedError with signature + logs", async () => {
  const f = fakeConn({ landAfterPolls: 1, err: { InstructionError: [2, { Custom: 6030 }] } });
  await assert.rejects(sendAndConfirm(f.conn, payer, [ix], [], { pollMs: 0, sleep: async () => {} }),
    (e: any) => e instanceof TxFailedError && !!e.signature && e.logs.length === 1);
});

test("sender: blockhash expiry → TxExpiredError (retryable message)", async () => {
  const f = fakeConn({ heights: [101] });
  await assert.rejects(sendAndConfirm(f.conn, payer, [ix], [], { pollMs: 0, sleep: async () => {} }),
    (e: any) => e instanceof TxExpiredError && /block height exceeded/.test(e.message));
});

// ---------------- scheduler watchdog ----------------
test("scheduler watchdog: a hung iteration is reported and the next tick still runs", async () => {
  const s = new Scheduler();
  let calls = 0;
  s.add("hang", 10, () => { calls++; return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve(); }, { watchdogMs: 80 });
  await new Promise((r) => setTimeout(r, 300));
  s.stop();
  const st = s.stats().find((x) => x.name === "hang")!;
  assert.equal(st.overruns, 1);
  assert.ok(calls >= 3, `ticks continued after the hang (${calls})`);
  assert.ok(st.runs >= 2);
});

// ---------------- sampler ----------------
const EP = Keypair.generate().publicKey.toBase58();
const E = Date.parse("2026-10-06T10:00:00Z") / 1000; // quick expiry; window = E−100 … E (10 × 10 s)
const ASSET: AssetState = { pubkey: "A", mint: "So111", decimals: 9, pythFeedId: "ef0d", strikeTick: 100_000n, maxConfBps: 50, maxSpotMoveBps: 50, maxSpotAgeSecs: 60, enabled: true, symbol: "SOL" };
const ep = (o: Partial<EpochState> = {}): EpochState => ({ pubkey: EP, asset: "A", kind: "Quick", expiry: E, nBuckets: 10, bucketSecs: 10, bucketToleranceSecs: 2, samples: [], sampleMask: 0, settlePrice: 0n, status: "Open", ...o });
const rd = (o: Partial<RoundState> = {}): RoundState => ({
  pubkey: "R", plan: "P", asset: "A", kind: "Put", strike: 1n, size: 1n, notional: 1n, epoch: EP, expiry: E, auctionStart: 0, auctionSecs: 30, poolDelaySecs: 10,
  rentPayer: "K", premiumStart: 1n, premiumFloor: 1n, spotAtOpen: 1n, maker: "M", makerIsPool: false, premiumPaid: 1n, feePaid: 0n, exercised: 0, settlePrice: 0n, memoHash: "", status: "Live", ...o,
});

test("dueSamples: bucket i is due at bucket_start + 2 s, only for epochs with a Live round, skips filled, stops after grace", () => {
  const v = { assets: [ASSET], rounds: [rd()], epochs: [ep()] };
  const ws = windowStart("Quick", E);
  assert.equal(ws, E - 100);
  assert.deepEqual(dueSamples(v, ws + SAMPLE_POST_DELAY_SECS - 1), []);
  assert.deepEqual(dueSamples(v, ws + SAMPLE_POST_DELAY_SECS).map((t) => t.bucket), [0]);
  assert.equal(dueSamples(v, ws + SAMPLE_POST_DELAY_SECS).at(0)!.publishTime, bucketStart("Quick", E, 0));
  assert.deepEqual(dueSamples(v, ws + 31).map((t) => t.bucket), [0, 1, 2]);
  assert.deepEqual(dueSamples({ ...v, epochs: [ep({ sampleMask: 0b101 })] }, ws + 31).map((t) => t.bucket), [1]);
  assert.deepEqual(dueSamples({ ...v, rounds: [rd({ status: "Auction" })] }, ws + 31), [], "no Live round → nothing");
  assert.deepEqual(dueSamples(v, E + 121), [], "after grace");
  assert.ok(samplingActive(v, ws - 60) && !samplingActive(v, ws - 61) && !samplingActive(v, E + 121));
});

function samplerHarness(o: { failFirst?: string; refreshHangs?: boolean } = {}) {
  let nowMs = (E - 100) * 1000;
  const posts: { bucket: number; at: number }[] = [];
  let refreshes = 0;
  let failed = false;
  const view = { assets: [ASSET], rounds: [rd()], epochs: [ep()] };
  const chain: any = {
    sampleView: () => { refreshes++; return refreshes > 1 && o.refreshHangs ? new Promise(() => {}) : Promise.resolve(view); },
    postSample: async (_s: any, _e: any, bucket: number) => {
      if (o.failFirst && !failed) { failed = true; const e: any = new Error("x"); e.logs = [`Program log: AnchorError Error Code: ${o.failFirst}. Error Number: 6030.`]; throw e; }
      posts.push({ bucket, at: Math.floor(nowMs / 1000) }); return ["a", "b"];
    },
  };
  const getUpdate = async (_f: string, t: number) => ({ binary: ["AA=="], parsed: { price: 120, conf: 0.01, publishTime: t, expo: -8, raw: { price: "", conf: "" } } });
  const sampler = new Sampler({ chain, signer: Keypair.generate(), getUpdate: getUpdate as any, now: () => nowMs });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    sampler, posts, refreshes: () => refreshes,
    async run(fromS: number, toS: number) { for (let s = fromS; s <= toS; s++) { nowMs = s * 1000; await sampler.tick(); await flush(); await flush(); } },
  };
}

test("Sampler: 1 s ticks post all 10 buckets, each at bucket_start + 2 s, exactly once", async () => {
  const h = samplerHarness();
  await h.run(E - 100, E + 5);
  assert.deepEqual(h.posts.map((p) => p.bucket), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const p of h.posts) assert.equal(p.at, bucketStart("Quick", E, p.bucket) + SAMPLE_POST_DELAY_SECS);
});

test("Sampler: a hung view refresh does not block posting (posts from the last view)", async () => {
  const h = samplerHarness({ refreshHangs: true });
  await h.run(E - 100, E + 5);
  assert.equal(h.posts.length, 10);
  assert.ok(h.refreshes() >= 2, "refresh was attempted (and hung) in the background");
});

test("Sampler: transient failure retried next second; BucketFilled is treated as done", async () => {
  const h = samplerHarness({ failFirst: "SpotMovedTooMuchXX" }); // unknown name → transient retry
  await h.run(E - 100, E + 5);
  assert.deepEqual(h.posts.map((p) => p.bucket), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(h.posts[0]!.at, bucketStart("Quick", E, 0) + SAMPLE_POST_DELAY_SECS + 1, "retried 1 s later");
  const g = samplerHarness({ failFirst: "BucketFilled" });
  await g.run(E - 100, E + 5);
  assert.deepEqual(g.posts.map((p) => p.bucket), [1, 2, 3, 4, 5, 6, 7, 8, 9], "bucket 0 not re-posted");
});

test("loop health: consecutive errors or a stale last success make /health unhealthy", () => {
  const base = { name: "x", runs: 1, errors: 0, consecutiveErrors: 0, lastOkAt: 1_000_000, lastError: null, running: false, overruns: 0, lastDurationMs: 5, intervalMs: 3_000 };
  assert.ok(loopHealthy(base, 1_000_000 + 119_000));
  assert.ok(!loopHealthy(base, 1_000_000 + 121_000), "no success for > 120 s");
  assert.ok(!loopHealthy({ ...base, consecutiveErrors: 5 }, 1_000_001));
  assert.ok(loopHealthy({ ...base, lastOkAt: null }, 50_000, 0), "not started yet");
  assert.ok(!loopHealthy({ ...base, lastOkAt: null }, 200_000, 10_000), "never succeeded since start");
});

// ---------------- makers: stale push feed ----------------
import { Makers } from "../src/makers/index.js";
import { SnapshotCache } from "../src/chain/snapshot-cache.js";
import { PublicKey } from "@solana/web3.js";

test("makers hold take_round while the push feed is stale, take once it is fresh, and retry after StalePrice", async () => {
  const now = Math.floor(Date.now() / 1000);
  const asset: AssetState = { ...ASSET, pubkey: Keypair.generate().publicKey.toBase58(), maxSpotAgeSecs: 180 };
  const round = rd({ pubkey: Keypair.generate().publicKey.toBase58(), asset: asset.pubkey, status: "Auction", kind: "Put", strike: 120_000_000n, size: 10_000_000n, notional: 1_200_000n,
    auctionStart: now, auctionSecs: 300, poolDelaySecs: 60, premiumStart: 1n, premiumFloor: 1n, expiry: now + 86_400, maker: null as any });
  const snap: any = { now, config: {}, assets: [asset], plans: [], rounds: [round], epochs: [], pool: null };
  let age = 200;
  const takes: string[] = [];
  let failNext: string | null = null;
  const chain: any = {
    snapshot: async () => snap,
    tokenBalance: async () => 10n ** 12n,
    spotAgeSecs: async (a: PublicKey) => { assert.equal(a.toBase58(), asset.pubkey); return age; },
    takeRound: async (_kp: Keypair, r: PublicKey) => {
      if (failNext) { const e: any = new Error(`AnchorError. Error Code: ${failNext}. Error Number: 6020. Error Message: x.`); failNext = null; throw e; }
      takes.push(r.toBase58()); return "sig";
    },
  };
  const pricer: any = { quote: async () => ({ ok: true, spot: 120, fairIv: 0.5 }) };
  const m = new Makers(chain, new SnapshotCache(chain, 0), pricer, [{ name: "maker-1", kp: Keypair.generate() }], Keypair.generate().publicKey);
  await m.tick();
  assert.equal(takes.length, 0, "stale (200 s > 180 − 15) → hold");
  age = 170; await m.tick();
  assert.equal(takes.length, 0, "170 s is inside the 15 s landing margin → still hold");
  age = 30; failNext = "StalePrice"; await m.tick();
  assert.equal(takes.length, 0, "landed StalePrice");
  await m.tick();
  assert.deepEqual(takes, [round.pubkey], "StalePrice is retried, not abandoned");
});

// ---------------- db: un-migrated Supabase falls back to memory ----------------
test("initRepo: Supabase with missing tables → in-process store (worker keeps running)", async () => {
  const { cfg } = await import("../src/config.js");
  const db = await import("../src/db/index.js");
  const saved = { u: cfg.supabaseUrl, k: cfg.supabaseServiceKey };
  (cfg as any).supabaseUrl = "https://example.supabase.co"; (cfg as any).supabaseServiceKey = "x";
  try {
    db.setRepoForTests(undefined as any);
    const probed: string[] = [];
    const r = await db.initRepo(async (t) => { probed.push(t); return t === "desk_runs" ? "Could not find the table 'public.desk_runs'" : null; });
    assert.equal(r.backend, "memory");
    assert.deepEqual(probed, [...db.REQUIRED_TABLES]);
    db.setRepoForTests(undefined as any);
    assert.equal((await db.initRepo(async () => null)).backend, "supabase");
  } finally { (cfg as any).supabaseUrl = saved.u; (cfg as any).supabaseServiceKey = saved.k; db.setRepoForTests(undefined as any); }
});

test("desk price_grid prices the next quick epoch as quick even 690 s out (desk 90 s lead)", async () => {
  const { isQuickHorizon } = await import("../src/desk-tools.js");
  const E = Date.parse("2026-10-06T06:00:00Z") / 1000;
  assert.ok(isQuickHorizon(E, E - 690));
  assert.ok(isQuickHorizon(E + 1200, E - 690));
  assert.ok(!isQuickHorizon(E + 12 * 3600, E));
});
