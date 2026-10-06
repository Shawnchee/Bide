// Shared script helpers: RPC from .env, keypairs loaded by path (never printed).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Connection, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, PublicKey } from "@solana/web3.js";
import { BideClient } from "@bide/shared";
import { makeRpcFetch } from "../../worker/src/chain/rpc.js";
import { sendAndConfirm } from "../../worker/src/chain/send.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true } as never);

export const RPC = process.env.HELIUS_RPC_URL || "https://api.devnet.solana.com";
// Per-request timeout + public-devnet fallback (worker/src/chain/rpc.ts) — integration run #2: a plain Connection
// could hang for 300 s on one request.
export const connection = new Connection(RPC, {
  commitment: "confirmed",
  fetch: makeRpcFetch({ primary: RPC, fallback: RPC.includes("api.devnet.solana.com") ? undefined : "https://api.devnet.solana.com", timeoutMs: 15_000, label: "script" }) as never,
  disableRetryOnRateLimit: true,
});
export const client = new BideClient(connection);

export function loadKeypair(name: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(ROOT, "keys", `${name}.json`), "utf8"))));
}

/** Robust send (priority fee, polling confirm + re-send; worker/src/chain/send.ts). Keeps the caller's CU-limit ix. */
export async function send(ixs: TransactionInstruction[], signers: Keypair[], alt?: AddressLookupTableAccount): Promise<string> {
  return sendAndConfirm(connection, signers[0]!, ixs, signers.slice(1), { alts: alt ? [alt] : [] });
}

export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export async function exists(pk: PublicKey) {
  return (await connection.getAccountInfo(pk)) !== null;
}
