// Reusable Pyth posting logic (FULL verification, encoded-VAA path) for the keeper (W lane).
//
// Built by hand (no @pythnetwork/pyth-solana-receiver runtime import): the SDK 0.16 ESM build pulls
// @pythnetwork/solana-utils → jito-ts → web3.js 1.77 and fails to load under Node ESM/tsx in this repo
// (ERR_PACKAGE_PATH_NOT_EXPORTED rpc-websockets / missing jito-ts dist path). The instructions below mirror
// the SDK's buildPostPriceUpdateInstructions exactly (same Anchor ix + account order), with the
// UPGRADED ("pro-compatible") program set: receiver rec2…, wormhole HDw2…, push oracle pyt2….
//
// Flow per Hermes update (one accumulator blob; may hold several feeds):
//   tx A: createAccount(encoded VAA) + init_encoded_vaa + write_encoded_vaa(all bytes, or part 1 if > 721 B)
//   tx B: [write part 2] + verify_encoded_vaa_v1 + post_update per feed  (+ caller's consumer ixs, e.g. post_sample,
//         + optionally the close ixs → "closeUpdateAccounts" in the same tx)
//   close: close_encoded_vaa + reclaim_rent per PriceUpdateV2 (payer must be the original poster)
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Signer, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";

export const RECEIVER_PROGRAM_ID = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
export const WORMHOLE_PROGRAM_ID = new PublicKey("HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL");
export const PUSH_ORACLE_PROGRAM_ID = new PublicKey("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou");

const VAA_START = 46;        // EncodedVaa header size (disc 8 + status 1 + write_authority 32 + version 1 + buf len 4)
const VAA_SPLIT_INDEX = 721; // same split as the SDK, keeps tx A under 1232 bytes
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bytes = (b: Buffer) => Buffer.concat([u32(b.length), b]);

// ---------- accumulator parsing ----------
export interface MerkleUpdate { message: Buffer; proof: Buffer[] }
export function parseAccumulator(update: Buffer): { vaa: Buffer; updates: MerkleUpdate[] } {
  if (update.subarray(0, 4).toString() !== "PNAU") throw new Error("not an accumulator update (PNAU)");
  let o = 6;
  o += 1 + update[o];               // trailing header
  if (update[o] !== 0) throw new Error("unsupported proof type"); o += 1;
  const vaaLen = update.readUInt16BE(o); o += 2;
  const vaa = update.subarray(o, o + vaaLen); o += vaaLen;
  const n = update[o]; o += 1;
  const updates: MerkleUpdate[] = [];
  for (let i = 0; i < n; i++) {
    const ml = update.readUInt16BE(o); o += 2;
    const message = update.subarray(o, o + ml); o += ml;
    const pl = update[o]; o += 1;
    const proof: Buffer[] = [];
    for (let j = 0; j < pl; j++) { proof.push(update.subarray(o, o + 20)); o += 20; }
    updates.push({ message, proof });
  }
  return { vaa, updates };
}
/** feed id (hex) of a price_feed message: [type u8 = 0][feed_id 32]… */
export const messageFeedId = (m: Buffer) => m.subarray(1, 33).toString("hex");

// ---------- PDAs ----------
export const guardianSetPda = (index: number) => {
  const b = Buffer.alloc(4); b.writeUInt32BE(index);
  return PublicKey.findProgramAddressSync([Buffer.from("GuardianSet"), b], WORMHOLE_PROGRAM_ID)[0];
};
export const receiverConfigPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], RECEIVER_PROGRAM_ID)[0];
export const treasuryPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("treasury"), Buffer.from([id])], RECEIVER_PROGRAM_ID)[0];
/** Push-feed shard PDA: seeds [u16 LE shard, feed_id(32)] under the push oracle program. */
export function pushFeedAddress(feedIdHex: string, shard = 0, program = PUSH_ORACLE_PROGRAM_ID): PublicKey {
  const s = Buffer.alloc(2); s.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([s, Buffer.from(feedIdHex.replace(/^0x/, ""), "hex")], program)[0];
}

// ---------- instruction builders ----------
const ix = (programId: PublicKey, keys: [PublicKey, boolean, boolean][], data: Buffer) =>
  new TransactionInstruction({ programId, keys: keys.map(([pubkey, isWritable, isSigner]) => ({ pubkey, isWritable, isSigner })), data });

export const initEncodedVaaIx = (auth: PublicKey, vaaAcc: PublicKey) =>
  ix(WORMHOLE_PROGRAM_ID, [[auth, false, true], [vaaAcc, true, false]], disc("init_encoded_vaa"));
export const writeEncodedVaaIx = (auth: PublicKey, vaaAcc: PublicKey, index: number, data: Buffer) =>
  ix(WORMHOLE_PROGRAM_ID, [[auth, false, true], [vaaAcc, true, false]], Buffer.concat([disc("write_encoded_vaa"), u32(index), bytes(data)]));
export const verifyEncodedVaaV1Ix = (auth: PublicKey, vaaAcc: PublicKey, guardianSet: PublicKey) =>
  ix(WORMHOLE_PROGRAM_ID, [[auth, false, true], [vaaAcc, true, false], [guardianSet, false, false]], disc("verify_encoded_vaa_v1"));
export const closeEncodedVaaIx = (auth: PublicKey, vaaAcc: PublicKey) =>
  ix(WORMHOLE_PROGRAM_ID, [[auth, true, true], [vaaAcc, true, false]], disc("close_encoded_vaa"));
export function postUpdateIx(payer: PublicKey, vaaAcc: PublicKey, priceUpdate: PublicKey, u: MerkleUpdate, treasuryId = 0) {
  const data = Buffer.concat([
    disc("post_update"), bytes(u.message), u32(u.proof.length), ...u.proof, Buffer.from([treasuryId]),
  ]);
  return ix(RECEIVER_PROGRAM_ID, [
    [payer, true, true], [vaaAcc, false, false], [receiverConfigPda(), false, false], [treasuryPda(treasuryId), true, false],
    [priceUpdate, true, true], [SystemProgram.programId, false, false], [payer, false, true],
  ], data);
}
export const reclaimRentIx = (payer: PublicKey, priceUpdate: PublicKey) =>
  ix(RECEIVER_PROGRAM_ID, [[payer, true, true], [priceUpdate, true, false]], disc("reclaim_rent"));

// ---------- high level ----------
export interface FullUpdatePlan {
  /** tx A instructions + extra signers */
  txA: { ixs: TransactionInstruction[]; signers: Signer[] };
  /** tx B instructions (verify + post_update) + extra signers; append consumer ixs after these */
  txB: { ixs: TransactionInstruction[]; signers: Signer[] };
  /** close_encoded_vaa + reclaim_rent (payer-signed); can be appended to tx B ("closeUpdateAccounts") */
  closeIxs: TransactionInstruction[];
  encodedVaa: PublicKey;
  /** feed id hex (no 0x) → PriceUpdateV2 account */
  priceUpdateAccounts: Record<string, PublicKey>;
  guardianSetIndex: number;
}

export async function buildFullUpdate(connection: Connection, payer: PublicKey, hermesUpdateBase64: string, treasuryId = 0): Promise<FullUpdatePlan> {
  const { vaa, updates } = parseAccumulator(Buffer.from(hermesUpdateBase64, "base64"));
  const guardianSetIndex = vaa.readUInt32BE(1);
  const vaaKp = Keypair.generate();
  const space = vaa.length + VAA_START;
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const txA: TransactionInstruction[] = [
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: vaaKp.publicKey, lamports, space, programId: WORMHOLE_PROGRAM_ID }),
    initEncodedVaaIx(payer, vaaKp.publicKey),
    writeEncodedVaaIx(payer, vaaKp.publicKey, 0, vaa.subarray(0, VAA_SPLIT_INDEX)),
  ];
  const txB: TransactionInstruction[] = [];
  if (vaa.length > VAA_SPLIT_INDEX) txB.push(writeEncodedVaaIx(payer, vaaKp.publicKey, VAA_SPLIT_INDEX, vaa.subarray(VAA_SPLIT_INDEX)));
  txB.push(verifyEncodedVaaV1Ix(payer, vaaKp.publicKey, guardianSetPda(guardianSetIndex)));
  const priceUpdateAccounts: Record<string, PublicKey> = {};
  const puSigners: Keypair[] = [];
  const closeIxs: TransactionInstruction[] = [closeEncodedVaaIx(payer, vaaKp.publicKey)];
  for (const u of updates) {
    const pu = Keypair.generate();
    puSigners.push(pu);
    priceUpdateAccounts[messageFeedId(u.message)] = pu.publicKey;
    txB.push(postUpdateIx(payer, vaaKp.publicKey, pu.publicKey, u, treasuryId));
    closeIxs.push(reclaimRentIx(payer, pu.publicKey));
  }
  return { txA: { ixs: txA, signers: [vaaKp] }, txB: { ixs: txB, signers: puSigners }, closeIxs, encodedVaa: vaaKp.publicKey, priceUpdateAccounts, guardianSetIndex };
}

/** Sends instructions as one v0 tx with a CU limit; throws (with logs) on failure. */
export async function sendTx(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Signer[] = [], cuLimit = 400_000): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 5 });
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

export interface PostedUpdate {
  priceUpdateAccounts: Record<string, PublicKey>;
  encodedVaa: PublicKey;
  signatures: string[];
  /** close_encoded_vaa + reclaim_rent; must be sent by the same payer */
  closeInstructions: TransactionInstruction[];
}

/**
 * Posts a Hermes accumulator update (base64, `binary.data[0]` from /v2/updates/price/…) with FULL verification
 * on the upgraded receiver. 2 transactions. `consumerIxs` (e.g. post_sample) go into the second tx after
 * post_update; `closeInSameTx: true` also appends the close ixs there (= SDK closeUpdateAccounts).
 */
export async function postFullUpdate(
  connection: Connection, payer: Keypair, hermesUpdateBase64: string,
  opts: { consumerIxs?: TransactionInstruction[]; closeInSameTx?: boolean } = {},
): Promise<PostedUpdate> {
  const p = await buildFullUpdate(connection, payer.publicKey, hermesUpdateBase64);
  const sigA = await sendTx(connection, payer, p.txA.ixs, p.txA.signers, 50_000);
  const tail = opts.closeInSameTx ? p.closeIxs : [];
  const sigB = await sendTx(connection, payer, [...p.txB.ixs, ...(opts.consumerIxs ?? []), ...tail], p.txB.signers, 600_000);
  return { priceUpdateAccounts: p.priceUpdateAccounts, encodedVaa: p.encodedVaa, signatures: [sigA, sigB], closeInstructions: opts.closeInSameTx ? [] : p.closeIxs };
}

export const closeUpdate = (connection: Connection, payer: Keypair, closeInstructions: TransactionInstruction[]) =>
  sendTx(connection, payer, closeInstructions, [], 100_000);

// ---------- PriceUpdateV2 decoding (posted updates and push feeds share the layout) ----------
export interface PriceUpdateV2 {
  writeAuthority: string;
  verificationLevel: string; // "Full" | "Partial(n)"
  feedId: string; price: bigint; conf: bigint; expo: number;
  publishTime: number; prevPublishTime: number; emaPrice: bigint; emaConf: bigint; postedSlot: bigint;
}
export function decodePriceUpdateV2(data: Buffer): PriceUpdateV2 {
  let o = 8;
  const writeAuthority = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32;
  let verificationLevel: string;
  if (data[o] === 1) { verificationLevel = "Full"; o += 1; } else { verificationLevel = `Partial(${data[o + 1]})`; o += 2; }
  const feedId = data.subarray(o, o + 32).toString("hex"); o += 32;
  const price = data.readBigInt64LE(o); o += 8;
  const conf = data.readBigUInt64LE(o); o += 8;
  const expo = data.readInt32LE(o); o += 4;
  const publishTime = Number(data.readBigInt64LE(o)); o += 8;
  const prevPublishTime = Number(data.readBigInt64LE(o)); o += 8;
  const emaPrice = data.readBigInt64LE(o); o += 8;
  const emaConf = data.readBigUInt64LE(o); o += 8;
  const postedSlot = data.readBigUInt64LE(o);
  return { writeAuthority, verificationLevel, feedId, price, conf, expo, publishTime, prevPublishTime, emaPrice, emaConf, postedSlot };
}
export const jsonBig = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
