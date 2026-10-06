// post_sample fed by the REAL encoded-VAA flow: genuine mainnet-Hermes SOL/USD updates (one per quick bucket,
// consecutive 10-s bucket starts) are verified by the real devnet Wormhole HDw2… + Pyth receiver rec2… binaries
// in LiteSVM, and consumed by post_sample in the same tx: [verify, post_update, post_sample, close_vaa, reclaim_rent].
// Fixture: tests/fixtures/pyth/hermes_quick_epoch.json (scripts/fetch-hermes-epoch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import { epochPda, median, pythToUsdc, WSOL_MINT } from "@bide/shared";
import { buildFullUpdate, decodePriceUpdateV2 } from "../../scripts/pyth/post.js";
import { FIX } from "./harness.js";
import { setupWorld } from "./fixtures.js";

const FILE = join(FIX, "pyth", "hermes_quick_epoch.json");

test("post_sample with real Full-verified Hermes VAAs (prev_publish_time bucket rule on genuine data)", { skip: !existsSync(FILE) }, async () => {
  const fx = JSON.parse(readFileSync(FILE, "utf8")) as { expiry: number; window_start: number; updates: { t: number; publish_time: number; base64: string }[] };
  const w = await setupWorld();
  const { env, admin } = w;
  const c = env.client;
  env.setTime(fx.expiry - 590); // no Lend interaction in this test, so the clock may precede the Lend dump
  env.send([await c.openEpoch(admin.publicKey, WSOL_MINT, "quick", fx.expiry)], [admin]);
  const epoch = epochPda(w.asset, 1, fx.expiry)[0];
  const poster = env.newWallet(10);
  const conn = { getMinimumBalanceForRentExemption: async (n: number) => Number(env.svm.minimumBalanceForRentExemption(BigInt(n))) } as never;

  const postReal = async (base64: string, bucket: number) => {
    const plan = await buildFullUpdate(conn, poster.publicKey, base64);
    env.send(plan.txA.ixs, [poster, ...(plan.txA.signers as Keypair[])]);
    const pu = Object.values(plan.priceUpdateAccounts)[0];
    const ixsB = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...plan.txB.ixs,
      await c.postSample(WSOL_MINT, epoch, pu, bucket),
      ...plan.closeIxs,
    ];
    return { ixsB, signers: [poster, ...(plan.txB.signers as Keypair[])], pu };
  };

  // negative first: update at bucket0_start + 1 → prev_publish_time == bucket_start → SampleOutsideBucket
  const neg = fx.updates.find((u) => u.t === fx.window_start + 1)!;
  env.setTime(fx.window_start + 5);
  const n = await postReal(neg.base64, 0);
  env.expectFail(n.ixsB, n.signers, "SampleOutsideBucket");
  // wrong bucket for a genuine update
  const b3 = fx.updates.find((u) => u.t === fx.window_start + 30)!;
  const wb = await postReal(b3.base64, 4);
  env.expectFail(wb.ixsB, wb.signers, "SampleOutsideBucket");

  const prices: bigint[] = [];
  for (let b = 0; b < 10; b++) {
    const u = fx.updates.find((x) => x.t === fx.window_start + b * 10)!;
    env.setTime(Math.max(env.now() + 1, u.t + 2));
    const r = await postReal(u.base64, b);
    const meta = env.send(r.ixsB, r.signers);
    if (b === 0) {
      console.log("tx B (verify+post_update+post_sample+close) CU:", meta.computeUnitsConsumed().toString());
    }
    assert.equal(env.getData(r.pu)?.length ?? 0, 0, "PriceUpdateV2 closed in the same tx");
    const e = env.decode<any>("epoch", epoch);
    prices.push(BigInt(e.samples[b].toString()));
  }
  env.setTime(fx.expiry);
  env.send([await c.resolveEpoch(epoch)], [admin]);
  const e = env.decode<any>("epoch", epoch);
  assert.ok("resolved" in e.status);
  assert.equal(BigInt(e.settlePrice.toString()), median(prices));
  console.log("real samples:", prices.join(","), "→ settle", e.settlePrice.toString());
  void decodePriceUpdateV2;
  void pythToUsdc;
});
