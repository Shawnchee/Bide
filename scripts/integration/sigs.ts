// Integration helper: tx history (time, ok/ERR, sig, Anchor instruction names) for accounts. Usage: tsx integration/sigs.ts <PK> [...]
import { PublicKey } from "@solana/web3.js";
import { connection } from "../lib/chain.js";
for (const a of process.argv.slice(2)) {
  const s = await connection.getSignaturesForAddress(new PublicKey(a), { limit: 30 });
  console.log("==", a);
  for (const x of s.reverse()) {
    const t = await connection.getTransaction(x.signature, { maxSupportedTransactionVersion: 0 });
    const ixn = (t?.meta?.logMessages ?? []).filter(l => l.startsWith("Program log: Instruction:")).map(l => l.slice(26)).join(",");
    console.log(new Date((x.blockTime ?? 0) * 1000).toISOString(), x.err ? "ERR" : "ok", x.signature, ixn);
  }
}
