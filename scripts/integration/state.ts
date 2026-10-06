// Integration helper: balances of every Bide wallet + program state summary (no secrets).
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ata, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { client, connection } from "../lib/chain.js";

export const WALLETS: Record<string, PublicKey> = {
  "demo-user": new PublicKey("6f7znmBfioj11fMmRTEnSC8xGgv2WTeHN9UpXo8fD3FY"),
  deployer: new PublicKey("HEf2YSqzg1nUk9gztyboYNtWiQyRJGkWfu24mSCChu1r"),
  keeper: new PublicKey("CXeiLyivTuHns3tyhusJiLMudtzgbbxyAaNLGZjGuBPh"),
  "maker-1": new PublicKey("FBrENVRrpAF6XR3nuxD5psm6Xompgs61iFJtPjGNpB24"),
  "maker-2": new PublicKey("9aa4zR5HnKfDm3vV5UeiuMpoS7vZLtZbj8u77kgebk69"),
};
const tok = async (mint: PublicKey, owner: PublicKey) => {
  try { return (await connection.getTokenAccountBalance(ata(mint, owner))).value.amount; } catch { return "-"; }
};
export async function balances() {
  const out: Record<string, { sol: number; usdc: string; wsol: string }> = {};
  for (const [n, pk] of Object.entries(WALLETS)) {
    out[n] = { sol: (await connection.getBalance(pk)) / LAMPORTS_PER_SOL, usdc: await tok(USDC_MINT, pk), wsol: await tok(WSOL_MINT, pk) };
  }
  return out;
}
async function main() {
  console.table(await balances());
  if (process.argv.includes("--state")) {
    const p = client.program as any;
    const [plans, rounds, epochs] = await Promise.all([p.account.plan.all(), p.account.round.all(), p.account.epoch.all()]);
    for (const x of plans) console.log("plan", x.publicKey.toBase58(), Object.keys(x.account.side)[0], "quick", x.account.quick, "status", Object.keys(x.account.status)[0], "target", x.account.targetStrike.toString(), "size", x.account.sizeTotal.toString(), "filled", x.account.sizeFilled.toString(), "active", x.account.activeRound?.toBase58?.(), "rounds", x.account.roundCount);
    for (const x of rounds) console.log("round", x.publicKey.toBase58(), Object.keys(x.account.status)[0], "strike", x.account.strike.toString(), "ex", x.account.exercised);
    for (const x of epochs) console.log("epoch", x.publicKey.toBase58(), Object.keys(x.account.kind)[0], new Date(x.account.expiry.toNumber() * 1000).toISOString(), Object.keys(x.account.status)[0], "mask", x.account.sampleMask);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
