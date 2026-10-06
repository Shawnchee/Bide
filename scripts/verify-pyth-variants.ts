// Variants: (a) old historical update (7 d), (b) closeUpdateAccounts in the same tx as post_update,
// (c) whole flow in ONE tx (size check), (d) BTC/USD.
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { readFileSync } from "node:fs";
import { Connection, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { HERMES_MAINNET, FEED_IDS, getAt } from "./pyth/hermes.js";
import { postFullUpdate, closeUpdate, buildFullUpdate, sendTx, decodePriceUpdateV2 } from "./pyth/post.js";

const root = new URL("..", import.meta.url).pathname;
const connection = new Connection(process.env.HELIUS_RPC_URL!, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${root}keys/keeper.json`, "utf8"))));
const now = Math.floor(Date.now() / 1000);
const cu = async (s: string) => (await connection.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))?.meta?.computeUnitsConsumed;

// (a) 7 days old
{
  const t = now - 7 * 86400;
  const r = await getAt(HERMES_MAINNET, [FEED_IDS.SOL_USD], t);
  console.log("(a) 7d-old hermes", r.status, r.parsed?.[0]?.price.publish_time);
  try {
    const p = await postFullUpdate(connection, payer, r.binary!.data[0], { closeInSameTx: true });
    console.log("(a) OK — posted+closed in tx2 (closeInSameTx)", p.signatures);
  } catch (e: any) { console.log("(a) FAIL", e.message, (e.logs ?? e.transactionLogs ?? []).slice(-6)); }
}
// (b) post + read in a separate step, closing in same tx is shown in (a); here measure tx2 size with close
// (c) single tx
{
  const r = await getAt(HERMES_MAINNET, [FEED_IDS.SOL_USD], now - 60);
  const plan = await buildFullUpdate(connection, payer.publicKey, r.binary!.data[0]);
  const { blockhash } = await connection.getLatestBlockhash();
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...plan.txA.ixs, ...plan.txB.ixs];
  try {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message());
    tx.sign([payer, ...plan.txA.signers, ...plan.txB.signers]);
    console.log("(c) single tx serialized bytes", tx.serialize().length, "(limit 1232)");
  } catch (e: any) { console.log("(c) single tx too large:", e.message); }
  const withClose = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...plan.txB.ixs, ...plan.closeIxs];
  const tx2 = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: withClose }).compileToV0Message());
  tx2.sign([payer, ...plan.txB.signers]);
  console.log("(b) tx2 (verify+post_update+close) bytes", tx2.serialize().length, "→ headroom for post_sample", 1232 - tx2.serialize().length);
}
// (d) BTC
{
  const r = await getAt(HERMES_MAINNET, [FEED_IDS.BTC_USD], now - 30);
  const p = await postFullUpdate(connection, payer, r.binary!.data[0]);
  const [feed, acct] = Object.entries(p.priceUpdateAccounts)[0];
  const d = decodePriceUpdateV2((await connection.getAccountInfo(acct))!.data);
  console.log("(d) BTC", feed, acct.toBase58(), d.verificationLevel, d.price.toString(), d.expo, d.publishTime, p.signatures, "CU", await cu(p.signatures[1]));
  console.log("(d) close", await closeUpdate(connection, payer, p.closeInstructions));
}
console.log("balance", (await connection.getBalance(payer.publicKey)) / 1e9);
