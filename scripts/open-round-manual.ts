// Manual open_round (agent = keeper key) priced by the REAL worker pricer. Integration test tool and the
// documented manual fallback for the std 08:00 UTC window when the desk (Z.ai) is unavailable.
//
// The memo is honest: { source: "manual-integration-test", pricer_output, ... } → canonical JSON → sha256 = memo_hash.
// It never writes desk_runs. The memo JSON is saved to notes/memos/<round>.json so the hash can be re-checked.
//
// Usage (from scripts/):
//   ./node_modules/.bin/tsx open-round-manual.ts --plan <PLAN_PK> [--wait] [--strike 119.30] [--size-frac 1]
//        [--auction-secs 30 quick | 300 std] [--expiry <unix>] [--source manual-fallback] [--note "..."] [--dry] [--simulate] [--force]
// Quick plans: targets the quick epoch whose auction window [E−600, E−540] contains now; --wait sleeps until the next one.
// Std plans:  targets --expiry, else the earliest std epoch ≥ now + 12 h allowed by the plan (window 08:00–08:30 UTC).
// Missing epoch → open_epoch first (permissionless). open_round is sent with skipPreflight so a program rejection
// is a real failed tx with an explorer link.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { epochPda, roundPda, EPOCH_PARAMS, minPremiumFloor, notionalFloor, premiumMeetsMin } from "@bide/shared";
import { client, connection, explorer, loadKeypair, ROOT } from "./lib/chain.js";
import { Pricer } from "../worker/src/pricer/index.js";
import { canonicalJson } from "../worker/src/desk/canonical.js";
import { sendAndConfirm } from "../worker/src/chain/send.js";
import { decodePriceUpdateV2 } from "./pyth/post.js";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// Robust sender (worker/src/chain/send.ts): skipPreflight so a rejection lands on-chain; polling confirm + re-send.
async function sendLanded(payer: Keypair, ixs: TransactionInstruction[], cu = 200_000) {
  try {
    return { sig: await sendAndConfirm(connection, payer, ixs, [], { cu, skipPreflight: true }), ok: true as const };
  } catch (e: any) {
    if (!e?.signature || !e?.txErr) throw e;
    return { sig: e.signature as string, ok: false as const, err: e.txErr, logs: (e.logs ?? []) as string[] };
  }
}

function quickTarget(now: number): number | null {
  const e = (Math.floor(now / 600) + 1) * 600; // next quick expiry
  return now >= e - 600 && now <= e - 540 ? e : null;
}

async function main() {
  const planPk = new PublicKey(arg("plan") ?? (() => { throw new Error("--plan required"); })());
  const agent = loadKeypair("keeper");
  const [cfg, plan] = await Promise.all([client.fetchConfig(), client.fetchPlan(planPk)]);
  if (!cfg.agent.equals(agent.publicKey)) throw new Error(`keys/keeper.json is not Config.agent (${cfg.agent.toBase58()})`);
  const asset = await (client.program as any).account.asset.fetch(plan.asset);
  const decimals: number = asset.decimals;
  const isPut = "buy" in plan.side || ("wheel" in plan.side && "accumulate" in plan.phase);
  const kind: "Std" | "Quick" = plan.quick ? "Quick" : "Std";
  if (plan.activeRound) throw new Error(`plan has an active round ${plan.activeRound.toBase58()}`);

  const pricer = new Pricer(["SOL"]);
  // ---- pick the epoch ----
  let expiry: number;
  if (kind === "Quick") {
    let e = quickTarget(nowS());
    if (e === null) {
      if (!has("wait")) throw new Error("not inside a quick auction window (pass --wait)");
      const next = (Math.floor(nowS() / 600) + 1) * 600;
      console.log(`waiting ${next - nowS()} s for the quick window of epoch ${new Date((next + 600) * 1000).toISOString()}`);
      // Warm the pricer ~20 s before the window: a cold venue fetch took ~40 s of the 60 s window in loop #1.
      while (nowS() < next - 20) await sleep(500);
      const t0 = Date.now(); await pricer.refreshAll(); console.log(`pricer warmed in ${Date.now() - t0} ms`);
      while (nowS() < next) await sleep(200);
      e = quickTarget(nowS())!;
    }
    expiry = e;
  } else {
    const limit = Math.min(nowS() + plan.maxExpirySecs, plan.horizonEnd.toNumber());
    expiry = Number(arg("expiry", "0"));
    if (!expiry) { expiry = Math.floor((nowS() + 12 * 3600 - 28_800) / 86_400) * 86_400 + 28_800; while (expiry < nowS() + 12 * 3600) expiry += 86_400; }
    if (expiry > limit) throw new Error(`expiry ${expiry} beyond plan limit ${limit}`);
  }
  const [epoch] = epochPda(plan.asset, kind, expiry, client.programId);
  if (!(await connection.getAccountInfo(epoch)) && has("simulate")) console.log(`epoch ${epoch.toBase58()} missing — a real run would open_epoch first (simulation will fail on it)`);
  else if (!(await connection.getAccountInfo(epoch))) {
    const r = await sendLanded(agent, [await client.openEpoch(agent.publicKey, plan.assetMint, kind === "Std" ? "std" : "quick", expiry)]);
    console.log("open_epoch", r.ok ? "ok" : "FAILED", explorer(r.sig));
    if (!r.ok) throw new Error("open_epoch failed");
  }

  // ---- strike / size ----
  const strike = arg("strike") ? BigInt(Math.round(Number(arg("strike")) * 1e6)) : BigInt((isPut ? plan.targetStrike : plan.exitStrike).toString());
  const remaining = BigInt(plan.sizeTotal.toString()) - BigInt(plan.sizeFilled.toString());
  const size = has("size-frac") ? (remaining * BigInt(Math.round(Number(arg("size-frac")) * 1000))) / 1000n : remaining;
  const notional = notionalFloor(strike, size, decimals);

  // ---- real pricer ----
  const tq = Date.now();
  const type = isPut ? "put" : "call";
  const q = await pricer.quote("SOL", type, Number(strike) / 1e6, expiry * 1000, Number(size) / 10 ** decimals, kind === "Quick");
  console.log(`pricer quote in ${Date.now() - tq} ms`);
  if (!q.ok) { console.error("pricer failed:", q.reason, JSON.stringify(q.rejected).slice(0, 800)); process.exit(2); }
  const floor = BigInt(Math.max(0, Math.ceil(q.floor)));
  const start = BigInt(Math.max(0, Math.ceil(q.start)));
  const auctionSecs = Number(arg("auction-secs", kind === "Quick" ? "30" : "300")); // std 300 s: decision 2026-10-06
  const secsToExpiry = expiry - nowS();
  const meets = premiumMeetsMin(floor, cfg.feeBps, notional, plan.minPremiumBpsPerDay, secsToExpiry);
  const pricerOutput = {
    asset: q.asset, type: q.type, strike_usd: q.strike, expiry_ms: q.expiry, size: q.size, spot: q.spot, t_years: q.tYears,
    fair_iv: q.fairIv, bid_iv: q.bidIv, fair_premium: q.fairPremium, bid_premium: q.bidPremium, start: q.start, floor: q.floor,
    floor_raised: q.floorRaised, fill_probability: q.fillProbability, quick_pricing: q.quick_pricing, ts: q.ts,
    venues: q.venues.map((v: any) => ({ venue: v.venue, mid_iv: v.midIv, bid_iv: v.bidIv, method: v.method })),
    rejected: q.rejected.map((r: any) => ({ venue: r.venue, reason: String(r.reason).slice(0, 160) })),
  };
  const [round] = roundPda(planPk, plan.roundCount, client.programId);
  const memo = {
    source: arg("source", "manual-integration-test"),
    note: arg("note", "Opened by scripts/open-round-manual.ts (keeper key). No desk/LLM run; parameters = worker pricer output as-is."),
    plan: planPk.toBase58(), round: round.toBase58(), round_index: plan.roundCount, epoch: epoch.toBase58(), epoch_kind: kind, expiry,
    kind: isPut ? "Put" : "Call", strike: strike.toString(), size: size.toString(), notional: notional.toString(),
    auction_secs: auctionSecs, premium_start: start.toString(), premium_floor: floor.toString(),
    user_min_floor: minPremiumFloor(cfg.feeBps, notional, plan.minPremiumBpsPerDay, secsToExpiry).toString(), fee_bps: cfg.feeBps,
    pricer_output: pricerOutput, created_at: new Date().toISOString(),
  };
  const memoJson = canonicalJson(memo);
  const memoHash = createHash("sha256").update(memoJson).digest();
  console.log({ round: round.toBase58(), expiry: new Date(expiry * 1000).toISOString(), strike: Number(strike) / 1e6, size: Number(size) / 10 ** decimals, spot: q.spot,
    fairIv: q.fairIv, fair: q.fairPremium, bid: q.bidPremium, start: start.toString(), floor: floor.toString(), pFill: q.fillProbability, meetsUserMin: meets, memoHash: memoHash.toString("hex") });
  if (!meets && !has("force")) { console.error("floor below the user's minimum (PremiumBelowUserMin) — pass --force to submit anyway"); process.exit(3); }
  if (floor <= 0n && !has("force")) { console.error("floor = 0 (program requires > 0)"); process.exit(3); }
  if (has("dry") && !has("simulate")) return;
  if (has("simulate")) {
    // Dress rehearsal: build the real open_round and simulate it (nothing is sent, no memo file written).
    // Outside the window the expected result is OutsideAuctionWindow — every account/plan check before it passed.
    const ix = await client.openRound(agent.publicKey, planPk, plan, asset, epoch, { strike, size, auctionSecs, premiumStart: start, premiumFloor: floor, memoHash });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: agent.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix] }).compileToV0Message();
    const tx = new VersionedTransaction(msg); tx.sign([agent]);
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    console.log("simulate open_round:", sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : "OK", `(${sim.value.unitsConsumed} CU)`);
    console.log((sim.value.logs ?? []).filter((l) => /Error|failed|Program log|consumed/.test(l)).join("\n"));
    return;
  }

  // The program reads spot from asset.spot_feed and rejects with StalePrice if it is older than max_spot_age_secs (devnet 180 s).
  // The sponsored push feed sometimes skips updates for ~5 min (seen 2026-10-06 04:45→04:50, which cost a quick round),
  // so wait (inside the auction window) until it is fresh enough to still be valid when the tx lands.
  const windowEnd = kind === "Quick" ? expiry - 540 : nowS() - (((nowS() - 28_800) % 86_400) + 86_400) % 86_400 + 1_800;
  const maxAge = Number(asset.maxSpotAgeSecs) - 20;
  for (;;) {
    const fi = await connection.getAccountInfo(asset.spotFeed);
    const age = nowS() - (fi ? decodePriceUpdateV2(fi.data).publishTime : 0);
    if (age <= maxAge) break;
    if (nowS() >= windowEnd - 3) { console.error(`push feed still stale (${age} s > ${maxAge} s) and the auction window is closing — not sending`); process.exit(5); }
    console.log(`push feed ${age} s old (> ${maxAge} s): waiting for a fresh update…`);
    await sleep(2_000);
  }

  const dir = join(ROOT, "notes", "memos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${round.toBase58()}.json`), memoJson + "\n");
  const ix = await client.openRound(agent.publicKey, planPk, plan, asset, epoch, { strike, size, auctionSecs, premiumStart: start, premiumFloor: floor, memoHash });
  const r = await sendLanded(agent, [ix]);
  if (r.ok) console.log("open_round OK", round.toBase58(), explorer(r.sig));
  else { console.log("open_round REJECTED", JSON.stringify(r.err), explorer(r.sig)); console.log(r.logs.filter((l) => /Error|failed|Program log/.test(l)).join("\n")); process.exit(4); }
  void EPOCH_PARAMS;
}
main().catch((e) => { console.error(e?.logs ?? e); process.exit(1); });
