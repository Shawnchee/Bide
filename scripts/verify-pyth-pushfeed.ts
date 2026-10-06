// Task 3: push feeds — PDA derivation, owner, verification level, publish_time cadence.
// Usage: tsx verify-pyth-pushfeed.ts [minutes=15] [intervalSec=30]
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { Connection, PublicKey } from "@solana/web3.js";
import { FEED_IDS } from "./pyth/hermes.js";
import { decodePriceUpdateV2, pushFeedAddress, PUSH_ORACLE_PROGRAM_ID } from "./pyth/post.js";
const [mins = "15", every = "30"] = process.argv.slice(2);
const connection = new Connection(process.env.HELIUS_RPC_URL!, "confirmed");
const OLD_PUSH = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const feeds = {
  "SOL/USD upgraded": [FEED_IDS.SOL_USD, PUSH_ORACLE_PROGRAM_ID, "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE"],
  "BTC/USD upgraded": [FEED_IDS.BTC_USD, PUSH_ORACLE_PROGRAM_ID, "APgzQGGdv2qCgBkX6aHVkrGePtBVDDg68GiqaM7rmtf5"],
  "SOL/USD previous": [FEED_IDS.SOL_USD, OLD_PUSH, "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"],
  "BTC/USD previous": [FEED_IDS.BTC_USD, OLD_PUSH, "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"],
} as const;
for (const [name, [id, prog, expected]] of Object.entries(feeds)) {
  const pda = pushFeedAddress(id, 0, prog as PublicKey);
  console.log(name, "PDA[u16LE 0, feed_id] under", (prog as PublicKey).toBase58().slice(0, 6), "=", pda.toBase58(), pda.toBase58() === expected ? "MATCH" : `MISMATCH (expected ${expected})`);
}
const seen: Record<string, number[]> = {};
const end = Date.now() + Number(mins) * 60_000;
while (true) {
  const now = Math.floor(Date.now() / 1000);
  const infos = await connection.getMultipleAccountsInfo(Object.values(feeds).map((f) => new PublicKey(f[2])));
  const row = Object.keys(feeds).map((name, i) => {
    const a = infos[i]; if (!a) return `${name}: MISSING`;
    const d = decodePriceUpdateV2(a.data);
    (seen[name] ??= []).includes(d.publishTime) || seen[name].push(d.publishTime);
    return `${name}: owner ${a.owner.toBase58().slice(0, 6)}… ${d.verificationLevel} pt ${d.publishTime} age ${now - d.publishTime}s px ${d.price}e${d.expo} slot ${d.postedSlot} wa ${d.writeAuthority.slice(0, 6)}…`;
  });
  console.log(new Date().toISOString(), "\n  " + row.join("\n  "));
  if (Date.now() > end) break;
  await new Promise((r) => setTimeout(r, Number(every) * 1000));
}
for (const [name, pts] of Object.entries(seen)) {
  const gaps = pts.slice(1).map((p, i) => p - pts[i]);
  console.log("SUMMARY", name, "distinct publish_times", pts.length, "gaps(s)", JSON.stringify(gaps), pts.map((p) => new Date(p * 1000).toISOString().slice(11, 19)).join(" "));
}
