// Integration: create a tiny quick (or std) plan for the deployer on devnet via the shared client.
// Usage: tsx integration/create-plan.ts --side buy|sell [--below-bps 10 | --above-bps 10 | --strike 119.30] [--size 0.02]
//        [--std] [--horizon-h 3] [--min-bps 10] [--owner deployer]
// Buy: strike = spot × (1 − below_bps/1e4), snapped DOWN to the $0.10 tick. Sell: spot × (1 + above_bps/1e4), snapped UP.
// Sell on SOL: wraps size + LEND_DUST_BUFFER lamports into the owner's WSOL ATA in the same tx.
import { SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { ata, BIDE_ALT, LEND_DUST_BUFFER, lendAuthPda, LEND_MARKETS, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { client, connection, explorer, loadKeypair, send } from "../lib/chain.js";
import { getLatestPrice, FEED_IDS } from "../../worker/src/pyth/hermes.js";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

async function main() {
  const side = (arg("side", "buy") as "buy" | "sell");
  const owner = loadKeypair(arg("owner", "deployer")!);
  const quick = !process.argv.includes("--std");
  const asset = await client.fetchAsset(WSOL_MINT);
  const tick = BigInt(asset.strikeTick.toString());
  const spot = (await getLatestPrice(FEED_IDS.SOL)).price;
  const spotU = BigInt(Math.round(spot * 1e6));
  let strike: bigint;
  if (arg("strike")) strike = BigInt(Math.round(Number(arg("strike")) * 1e6));
  else if (side === "buy") strike = ((spotU * BigInt(10_000 - Number(arg("below-bps", "10")))) / 10_000n / tick) * tick;
  else { const raw = (spotU * BigInt(10_000 + Number(arg("above-bps", "10")))) / 10_000n; strike = ((raw + tick - 1n) / tick) * tick; }
  const size = BigInt(Math.round(Number(arg("size", "0.02")) * 1e9));
  const now = Math.floor(Date.now() / 1000);
  const horizonEnd = now + Math.round(Number(arg("horizon-h", quick ? "3" : "48")) * 3600);
  const nonce = BigInt(Date.now());
  console.log({ side, quick, spot, strike: strike.toString(), strikeUsd: Number(strike) / 1e6, distBps: Number(((strike - spotU) * 10_000n) / spotU), size: size.toString(), horizonEnd: new Date(horizonEnd * 1000).toISOString() });
  const { ixs, plan } = await client.createPlan(owner.publicKey, WSOL_MINT, {
    nonce, side, quick,
    targetStrike: side === "buy" ? strike : 0n,
    exitStrike: side === "sell" ? strike : 0n,
    sizeTotal: size,
    minPremiumBpsPerDay: Number(arg("min-bps", "10")),
    maxExpirySecs: quick ? 3600 : 30 * 86400,
    horizonEnd,
    maxRoundsPerDay: quick ? 30 : 6,
  });
  const pre = [];
  if (side === "sell") {
    const wsolAta = ata(WSOL_MINT, owner.publicKey);
    pre.push(
      createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, wsolAta, owner.publicKey, WSOL_MINT),
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wsolAta, lamports: size + LEND_DUST_BUFFER }),
      createSyncNativeInstruction(wsolAta),
    );
  }
  const alt = (await connection.getAddressLookupTable(BIDE_ALT)).value!;
  // keep the CU-limit ix first
  const sig = await send([ixs[0]!, ...pre, ...ixs.slice(1)], [owner], alt);
  console.log("create_plan", plan.toBase58(), explorer(sig));
  const p = await client.fetchPlan(plan);
  const [la] = lendAuthPda(plan);
  const fMint = side === "sell" ? LEND_MARKETS.WSOL.fTokenMint : LEND_MARKETS.USDC.fTokenMint;
  const f = await connection.getTokenAccountBalance(ata(fMint, la));
  console.log({ plan: plan.toBase58(), collateralPrincipal: p.collateralPrincipal.toString(), lendShares: p.lendShares.toString(), fTokenVault: f.value.amount, fTokenMint: fMint.toBase58(), ownerUsdcAfter: (await connection.getTokenAccountBalance(ata(USDC_MINT, owner.publicKey)).catch(() => null))?.value.amount });
}
main().catch((e) => { console.error(e?.logs ?? e); process.exit(1); });
