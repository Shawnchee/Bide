import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, EPOCH_KIND } from "./constants.js";

const enc = (s: string) => Buffer.from(s);
const u64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const find = (seeds: Buffer[], programId = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, programId);

export const configPda = (programId = PROGRAM_ID) => find([enc(SEEDS.config)], programId);
export const assetPda = (mint: PublicKey, programId = PROGRAM_ID) => find([enc(SEEDS.asset), mint.toBuffer()], programId);
export const planPda = (owner: PublicKey, nonce: bigint | number, programId = PROGRAM_ID) =>
  find([enc(SEEDS.plan), owner.toBuffer(), u64le(nonce)], programId);
export const roundPda = (plan: PublicKey, roundIndex: number, programId = PROGRAM_ID) =>
  find([enc(SEEDS.round), plan.toBuffer(), u32le(roundIndex)], programId);
/** kind: 0 = Std, 1 = Quick */
export const epochPda = (asset: PublicKey, kind: number | "Std" | "Quick", expiry: bigint | number, programId = PROGRAM_ID) => {
  const k = typeof kind === "string" ? EPOCH_KIND[kind] : kind;
  return find([enc(SEEDS.epoch), asset.toBuffer(), Buffer.from([k]), i64le(expiry)], programId);
};
export const poolPda = (programId = PROGRAM_ID) => find([enc(SEEDS.pool)], programId);
export const poolMintPda = (programId = PROGRAM_ID) => find([enc(SEEDS.poolMint)], programId);
export const escrowPda = (round: PublicKey, programId = PROGRAM_ID) => find([enc(SEEDS.escrow), round.toBuffer()], programId);
/** Data-less signer that owns every plan/pool vault: ["lend_auth", plan|pool] */
export const lendAuthPda = (planOrPool: PublicKey, programId = PROGRAM_ID) =>
  find([enc(SEEDS.lendAuth), planOrPool.toBuffer()], programId);

/** ATA (classic Token program), allows off-curve owners (PDAs). */
export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** All vaults of a plan (owned by its lend_auth PDA). */
export function planVaults(plan: PublicKey, assetMint: PublicKey, fTokenMints: { usdc: PublicKey; asset?: PublicKey | null }) {
  const [lendAuth] = lendAuthPda(plan);
  return {
    lendAuth,
    usdc: ata(new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), lendAuth),
    usdcFToken: ata(fTokenMints.usdc, lendAuth),
    asset: ata(assetMint, lendAuth),
    assetFToken: fTokenMints.asset ? ata(fTokenMints.asset, lendAuth) : null,
  };
}
