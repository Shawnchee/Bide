// Devnet smoke test of the real Lend CPI: create a tiny Buy plan (deployer, ~1 USDC) then close it.
import { ata, BIDE_ALT, USDC_MINT, WSOL_MINT, lendAuthPda, LEND_MARKETS } from "@bide/shared";
import { client, connection, explorer, loadKeypair, send } from "./lib/chain.js";

async function main() {
  const owner = loadKeypair("deployer");
  const alt = (await connection.getAddressLookupTable(BIDE_ALT)).value!;
  const nonce = BigInt(Date.now());
  const { ixs, plan } = await client.createPlan(owner.publicKey, WSOL_MINT, {
    nonce, side: "buy", quick: false, targetStrike: 100_000_000n, sizeTotal: 10_000_000n, // 0.01 SOL @ $100 = 1 USDC
    minPremiumBpsPerDay: 10, maxExpirySecs: 7 * 86400, horizonEnd: Math.floor(Date.now() / 1000) + 2 * 86400, maxRoundsPerDay: 6,
  });
  console.log("create_plan", plan.toBase58(), explorer(await send(ixs, [owner], alt)));
  const [la] = lendAuthPda(plan);
  const f = await connection.getTokenAccountBalance(ata(LEND_MARKETS.USDC.fTokenMint, la));
  const p = await client.fetchPlan(plan);
  console.log("plan lend_shares", p.lendShares.toString(), "fToken vault", f.value.amount, "principal", p.collateralPrincipal.toString());
  if (process.argv.includes("--keep")) return;
  console.log("close_plan", explorer(await send(await client.closePlan(owner.publicKey, plan, p), [owner], alt)));
  const u = await connection.getTokenAccountBalance(ata(USDC_MINT, owner.publicKey));
  console.log("owner USDC after close", u.value.uiAmountString);
}
main().catch((e) => {
  console.error(e?.logs ?? e);
  process.exit(1);
});
