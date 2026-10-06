// Create (or extend) the devnet address lookup table with every static account used by Bide's Lend CPIs.
// Prints the ALT address; it is then hardcoded in packages/shared/src/constants.ts (BIDE_ALT).
import { AddressLookupTableProgram, ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { lendAltAddresses, PROGRAM_ID, configPda, assetPda, WSOL_MINT, PYTH_PUSH_FEEDS, PYTH_RECEIVER_PROGRAM_ID } from "@bide/shared";
import { connection, explorer, loadKeypair, send } from "./lib/chain.js";

async function main() {
  const payer = loadKeypair("deployer");
  const wanted: PublicKey[] = [
    ...lendAltAddresses(),
    PROGRAM_ID,
    configPda()[0],
    assetPda(WSOL_MINT)[0],
    PYTH_PUSH_FEEDS.SOL_USD,
    PYTH_RECEIVER_PROGRAM_ID,
    WSOL_MINT,
    ComputeBudgetProgram.programId,
  ];
  let altAddr = process.argv[2] ? new PublicKey(process.argv[2]) : null;
  if (!altAddr) {
    const slot = await connection.getSlot("finalized");
    const [ix, addr] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
    console.log("create", explorer(await send([ix], [payer])));
    altAddr = addr;
  }
  const cur = (await connection.getAddressLookupTable(altAddr)).value?.state.addresses ?? [];
  const missing = wanted.filter((a, i) => wanted.findIndex((b) => b.equals(a)) === i && !cur.some((c) => c.equals(a)));
  for (let i = 0; i < missing.length; i += 20) {
    const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: altAddr, authority: payer.publicKey, payer: payer.publicKey, addresses: missing.slice(i, i + 20) });
    console.log("extend", explorer(await send([ix], [payer])));
  }
  console.log("ALT", altAddr.toBase58(), "entries", cur.length + missing.length);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
