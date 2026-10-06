// Task 4 feasibility: run the FULL encoded-VAA post flow inside LiteSVM with dumped devnet programs/accounts.
// litesvm + @solana/kit are resolved from the tests package (not a scripts dep).
import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url).pathname });
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { buildFullUpdate, decodePriceUpdateV2, jsonBig } from "./post.js";
import { HERMES_MAINNET, FEED_IDS, getAt } from "./hermes.js";

const root = new URL("../../", import.meta.url).pathname;
const fx = `${root}tests/fixtures/pyth`;
const lsDir = `${root}tests/node_modules/litesvm`;
const { LiteSVM } = await import(`${lsDir}/dist/index.js`);
const kit = await import(`${root}node_modules/.pnpm/${(await import("node:fs")).readdirSync(`${root}node_modules/.pnpm`).find((d) => d.startsWith("litesvm@1.5.0"))}/node_modules/@solana/kit/dist/index.node.mjs`);

// 1. a historical Hermes update, saved as a fixture (replayable offline)
const blobFile = `${fx}/hermes_sol_usd.json`;
let blob: { publish_time: number; base64: string };
if (existsSync(blobFile)) blob = JSON.parse(readFileSync(blobFile, "utf8"));
else {
  const t = Math.floor(Date.now() / 1000) - 300;
  const r = await getAt(HERMES_MAINNET, [FEED_IDS.SOL_USD], t);
  blob = { publish_time: r.parsed![0].price.publish_time, base64: r.binary!.data[0] };
  writeFileSync(blobFile, JSON.stringify(blob, null, 1));
}

// 2. LiteSVM with dumped programs + accounts
const svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false);
svm.addProgramFromFile(kit.address("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp"), `${fx}/receiver_rec2.so`);
svm.addProgramFromFile(kit.address("HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL"), `${fx}/wormhole_HDw2.so`);
for (const f of ["guardian_set_1", "receiver_config"]) {
  const j = JSON.parse(readFileSync(`${fx}/${f}.json`, "utf8"));
  const data = Buffer.from(j.account.data[0], "base64");
  svm.setAccount({ address: kit.address(j.pubkey), data: new Uint8Array(data), executable: false, lamports: kit.lamports(BigInt(j.account.lamports)), programAddress: kit.address(j.account.owner), space: BigInt(data.length) });
}
const payer = Keypair.generate();
svm.airdrop(kit.address(payer.publicKey.toBase58()), kit.lamports(10_000_000_000n));
const clockBefore = svm.getClock();
console.log("litesvm clock unix_timestamp", clockBefore.unixTimestamp, "vaa publish_time", blob.publish_time);

// 3. same instructions as devnet (buildFullUpdate needs only getMinimumBalanceForRentExemption)
const fakeConn = { getMinimumBalanceForRentExemption: async (n: number) => Number(svm.minimumBalanceForRentExemption(BigInt(n))) } as any;
const plan = await buildFullUpdate(fakeConn, payer.publicKey, blob.base64);
const toKitIx = (i: TransactionInstruction) => ({
  programAddress: kit.address(i.programId.toBase58()),
  accounts: i.keys.map((k) => ({ address: kit.address(k.pubkey.toBase58()), role: (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0) })),
  data: new Uint8Array(i.data),
});
const send = (ixs: TransactionInstruction[], label: string) => {
  let msg = kit.createTransactionMessage({ version: 0 });
  msg = kit.setTransactionMessageFeePayer(kit.address(payer.publicKey.toBase58()), msg);
  msg = kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0n }, msg);
  msg = kit.appendTransactionMessageInstructions(ixs.map(toKitIx), msg);
  const tx = kit.compileTransaction(msg);
  const res = svm.sendTransaction(tx);
  const ok = typeof res.err !== "function";
  const logs = ok ? res.logs() : res.meta().logs();
  console.log(label, ok ? "OK" : `FAIL ${res.err()?.toString?.() ?? ""}`, "CU", ok ? res.computeUnitsConsumed() : res.meta().computeUnitsConsumed());
  if (!ok) console.log(logs.slice(-8).join("\n"));
  return ok;
};
const okA = send(plan.txA.ixs, "txA create+init+write");
const okB = okA && send(plan.txB.ixs, "txB verify+post_update");
if (okB) {
  const [feed, acct] = Object.entries(plan.priceUpdateAccounts)[0];
  const a = svm.getAccount(kit.address(acct.toBase58()));
  console.log("LiteSVM PriceUpdateV2", feed, a.programAddress, jsonBig(decodePriceUpdateV2(Buffer.from(a.data))));
}
// 4. does clock matter? warp far ahead and re-run with a fresh plan
{ const c = svm.getClock(); c.unixTimestamp = BigInt(blob.publish_time + 365 * 86400); svm.setClock(c); }
const plan2 = await buildFullUpdate(fakeConn, payer.publicKey, blob.base64);
const ok2 = send(plan2.txA.ixs, "[clock +1y] txA") && send(plan2.txB.ixs, "[clock +1y] txB");
{ const c = svm.getClock(); c.unixTimestamp = 0n; svm.setClock(c); }
const plan3 = await buildFullUpdate(fakeConn, payer.publicKey, blob.base64);
const ok3 = send(plan3.txA.ixs, "[clock 0] txA") && send(plan3.txB.ixs, "[clock 0] txB");
console.log("RESULT full-flow-in-litesvm", okB, "clock-independent", ok2 && ok3);
