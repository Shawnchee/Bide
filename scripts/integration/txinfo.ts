import { connection } from "/Users/shawnchee/Desktop/projects/deeznuts/scripts/lib/chain.js";
for (const s of process.argv.slice(2)) {
  const t = await connection.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log(s.slice(0, 10), t?.blockTime ? new Date(t.blockTime * 1000).toISOString() : "?", "err", JSON.stringify(t?.meta?.err), "fee", t?.meta?.fee, "cu", t?.meta?.computeUnitsConsumed);
  if (process.env.LOGS) console.log((t?.meta?.logMessages ?? []).join("\n"));
}
