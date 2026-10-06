// Inspect devnet wormhole guardian sets (upgraded + previous) and the guardian-set index/signers of a mainnet Hermes VAA.
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { Connection, PublicKey } from "@solana/web3.js";
import { vaaInfo } from "./pyth/accumulator.js";
import { parseAccumulator } from "./pyth/post.js";
import { getGuardianSetPda, getConfigPda } from "@pythnetwork/pyth-solana-receiver/address";
import { HERMES_MAINNET, FEED_IDS, getLatest } from "./pyth/hermes.js";

const conn = new Connection(process.env.HELIUS_RPC_URL!, "confirmed");
console.log("genesis", await conn.getGenesisHash(), "(devnet = EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG)");
const sets = { upgraded: "HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL", previous: "HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ" };
const guardianKeys: Record<string, string[]> = {};
for (const [name, wh] of Object.entries(sets)) {
  for (let i = 0; i <= 6; i++) {
    const pda = getGuardianSetPda(i, new PublicKey(wh));
    const acc = await conn.getAccountInfo(pda);
    if (!acc) continue;
    // GuardianSet: disc(8) index u32, keys vec<[u8;20]>, creation_time u32, expiration_time u32
    const d = acc.data; let o = 0; // legacy layout, no discriminator
    console.log("  raw len", d.length, "head", d.subarray(0, 16).toString("hex"));
    if (d.readUInt32LE(4) > 64) o = 8; // anchor-style discriminator present
    const idx = d.readUInt32LE(o); o += 4;
    const n = d.readUInt32LE(o); o += 4;
    const keys: string[] = [];
    for (let k = 0; k < n; k++) { keys.push(d.subarray(o, o + 20).toString("hex")); o += 20; }
    const created = d.readUInt32LE(o); const exp = d.readUInt32LE(o + 4);
    guardianKeys[`${name}:${i}`] = keys;
    console.log(name, "guardianSet", i, pda.toBase58(), "owner", acc.owner.toBase58(), "idx", idx, "nKeys", n, "created", created, "expires", exp, "first", keys[0]);
  }
}
for (const rec of ["rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp", "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"]) {
  const cfg = getConfigPda(new PublicKey(rec));
  const a = await conn.getAccountInfo(cfg);
  if (!a) { console.log(rec, "config missing"); continue; }
  // Config: disc, governance_authority(32), target_governance_authority Option<Pubkey>, wormhole Pubkey, valid_data_sources vec, single_update_fee_in_lamports u64, minimum_signatures u8
  const d = a.data; let o = 8 + 32;
  o += d[o] === 1 ? 33 : 1;
  const wormhole = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
  const nSrc = d.readUInt32LE(o); o += 4; const srcs: string[] = [];
  for (let s = 0; s < nSrc; s++) { srcs.push(`chain ${d.readUInt16LE(o)} emitter ${new PublicKey(d.subarray(o + 2, o + 34)).toBuffer().toString("hex")}`); o += 34; }
  const fee = d.readBigUInt64LE(o); o += 8; const minSigs = d[o];
  console.log("receiver", rec, "config", cfg.toBase58(), "wormhole", wormhole, "fee", fee.toString(), "minSigs", minSigs, "sources", srcs);
}
const m = await getLatest(HERMES_MAINNET, [FEED_IDS.SOL_USD]);
const vaa = parseAccumulator(Buffer.from(m.binary!.data[0], "base64")).vaa;
console.log("mainnet VAA", vaaInfo(vaa));
