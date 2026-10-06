import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { WSOL_MINT } from "./constants";

/** Wrap native SOL into the owner's WSOL ATA (idempotent create + transfer + sync). */
export function wrapSolIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const ata = getAssociatedTokenAddressSync(WSOL_MINT, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, WSOL_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata),
  ];
}
