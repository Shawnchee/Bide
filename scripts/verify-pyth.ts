// Task 1/4: post a Hermes SOL/USD update through the upgraded receiver (rec2…) with FULL verification,
// read the PriceUpdateV2, optionally dump it as a LiteSVM fixture, then close the accounts.
// Usage: tsx verify-pyth.ts [beta|mainnet|both] [--fixture] [--at <unix>]
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { HERMES_BETA, HERMES_MAINNET, FEED_IDS, getLatest, getAt } from "./pyth/hermes.js";

import { postFullUpdate, closeUpdate, decodePriceUpdateV2, parseAccumulator, RECEIVER_PROGRAM_ID } from "./pyth/post.js";
import { vaaInfo } from "./pyth/accumulator.js";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const which = args.find((a) => ["beta", "mainnet", "both"].includes(a)) ?? "both";
const fixture = args.includes("--fixture");
const atIdx = args.indexOf("--at");
const at = atIdx >= 0 ? Number(args[atIdx + 1]) : undefined;

const rpc = process.env.HELIUS_RPC_URL!;
const connection = new Connection(rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${root}keys/keeper.json`, "utf8"))));
const ex = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
console.log("payer", payer.publicKey.toBase58(), "balance SOL", (await connection.getBalance(payer.publicKey)) / 1e9);

const sources = which === "both" ? [HERMES_BETA, HERMES_MAINNET] : [which === "beta" ? HERMES_BETA : HERMES_MAINNET];
for (const base of sources) {
  console.log(`\n=== source ${base} ${at ? `@${at}` : "latest"} ===`);
  const r = at ? await getAt(base, [FEED_IDS.SOL_USD], at) : await getLatest(base, [FEED_IDS.SOL_USD]);
  console.log("hermes HTTP", r.status, r.raw ?? "");
  if (!r.binary) continue;
  const b64 = r.binary.data[0];
  console.log("vaa", vaaInfo(parseAccumulator(Buffer.from(b64, "base64")).vaa), "len", parseAccumulator(Buffer.from(b64, "base64")).vaa.length, "hermes parsed publish_time", r.parsed?.[0]?.price.publish_time);
  let posted;
  try {
    posted = await postFullUpdate(connection, payer, b64);
  } catch (e: any) {
    console.log("POST FAILED:", e.message);
    if (e.logs) console.log(e.logs.join("\n")); else if (e.transactionLogs) console.log(e.transactionLogs.join("\n"));
    continue;
  }
  for (const [i, s] of posted.signatures.entries()) {
    const t = await connection.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    console.log(`post tx${i + 1}`, s, ex(s), "CU", t?.meta?.computeUnitsConsumed, "fee", t?.meta?.fee, "blockTime", t?.blockTime);
  }
  for (const [feed, acct] of Object.entries(posted.priceUpdateAccounts)) {
    const info = await connection.getAccountInfo(acct);
    const d = decodePriceUpdateV2(info!.data);
    console.log("PriceUpdateV2", acct.toBase58(), "owner", info!.owner.toBase58(), "ownerIsRec2", info!.owner.equals(RECEIVER_PROGRAM_ID),
      "len", info!.data.length, "lamports", info!.lamports, JSON.stringify(d, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (fixture) {
      const dir = `${root}tests/fixtures/pyth`;
      mkdirSync(dir, { recursive: true });
      const file = `${dir}/sol_usd_full_${d.publishTime}.json`;
      writeFileSync(file, execFileSync("solana", ["account", acct.toBase58(), "--output", "json", "--url", "devnet"]));
      appendFileSync(`${dir}/README.md`, `- \`sol_usd_full_${d.publishTime}.json\` — PriceUpdateV2 @ ${acct.toBase58()} (owner rec2…), feed ${feed} SOL/USD, publish_time ${d.publishTime}, price ${d.price} expo ${d.expo} conf ${d.conf}, verification ${d.verificationLevel}, source ${base}, posted slot ${d.postedSlot}\n`);
      console.log("fixture written", file);
    }
  }
  const closeSig = await closeUpdate(connection, payer, posted.closeInstructions);
  console.log("close tx", closeSig, ex(closeSig));
  const after = await Promise.all([posted.encodedVaa, ...Object.values(posted.priceUpdateAccounts)].map((a) => connection.getAccountInfo(a)));
  console.log("accounts after close exist?", after.map((a) => !!a));
}
console.log("\nbalance after SOL", (await connection.getBalance(payer.publicKey)) / 1e9);
