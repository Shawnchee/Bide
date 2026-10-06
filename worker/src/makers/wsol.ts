// Makers escrow WSOL for put rounds: top up each maker's WSOL ATA to a target at startup, keeping a native
// SOL reserve for fees/rent. Env: MAKER_WSOL_TARGET (SOL, default 1.0), MAKER_SOL_RESERVE (SOL, default 0.5).
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { sendTx } from "../pyth/post.js";
import { logger } from "../log.js";

const log = logger("makers");

/** Lamports to wrap so that WSOL reaches `target` while leaving `reserve` native SOL. Pure. */
export function wrapAmount(nativeLamports: bigint, wsolLamports: bigint, target: bigint, reserve: bigint): bigint {
  if (wsolLamports >= target) return 0n;
  const want = target - wsolLamports;
  const spendable = nativeLamports > reserve ? nativeLamports - reserve : 0n;
  return want < spendable ? want : spendable;
}

export async function topUpWsol(connection: Connection, kp: Keypair, name: string) {
  const target = BigInt(Math.round(Number(process.env.MAKER_WSOL_TARGET ?? "1") * LAMPORTS_PER_SOL));
  const reserve = BigInt(Math.round(Number(process.env.MAKER_SOL_RESERVE ?? "0.5") * LAMPORTS_PER_SOL));
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, kp.publicKey);
  const native = BigInt(await connection.getBalance(kp.publicKey));
  const wsol = await connection.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  const amt = wrapAmount(native, wsol, target, reserve);
  if (amt <= 0n) { log.info("wsol ok", { maker: name, wsol: Number(wsol) / LAMPORTS_PER_SOL }); return; }
  const sig = await sendTx(connection, kp, [
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: amt }),
    createSyncNativeInstruction(ata),
  ], [], 50_000);
  log.info("wrapped SOL → WSOL", { maker: name, sol: Number(amt) / LAMPORTS_PER_SOL, sig });
}
