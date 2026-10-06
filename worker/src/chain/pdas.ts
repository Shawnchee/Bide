// PDA derivations from BUILD §3.2 seeds. TODO(P lane): switch to packages/shared/src/pda.ts when published;
// test/chain.test.ts keeps cross-checking the seeds.
import { PublicKey } from "@solana/web3.js";
import type { EpochKind } from "../keeper/schedule.js";

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
export const EPOCH_KIND_U8: Record<EpochKind, number> = { Std: 0, Quick: 1 };

export function pdas(programId: PublicKey) {
  const find = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    config: () => find([Buffer.from("config")]),
    asset: (mint: PublicKey) => find([Buffer.from("asset"), mint.toBuffer()]),
    plan: (owner: PublicKey, nonce: bigint | number) => find([Buffer.from("plan"), owner.toBuffer(), u64le(nonce)]),
    round: (plan: PublicKey, index: number) => find([Buffer.from("round"), plan.toBuffer(), u32le(index)]),
    epoch: (asset: PublicKey, kind: EpochKind, expiry: number) => find([Buffer.from("epoch"), asset.toBuffer(), Buffer.from([EPOCH_KIND_U8[kind]]), i64le(expiry)]),
    pool: () => find([Buffer.from("pool")]),
    escrow: (round: PublicKey) => find([Buffer.from("escrow"), round.toBuffer()]),
    lendAuth: (owner: PublicKey) => find([Buffer.from("lend_auth"), owner.toBuffer()]),
  };
}
export type Pdas = ReturnType<typeof pdas>;
