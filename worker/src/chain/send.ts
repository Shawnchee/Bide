// Robust transaction sender (integration run #2). Replaces web3.js confirmTransaction (websocket subscription +
// block-height race), which produced "block height exceeded" on slow confirms in run #1 even when the RPC was fine.
//   fresh blockhash → CU limit + small CU price → send → poll getSignatureStatuses and RE-SEND the same signed tx
//   every few seconds until it is confirmed or the blockhash expires (then a final status check).
// Every RPC call here is already bounded by the Connection's fetch timeout (chain/rpc.ts); poll errors are tolerated.
import {
  ComputeBudgetProgram, Connection, Keypair, SendTransactionError, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type Signer,
} from "@solana/web3.js";
import { utils } from "@anchor-lang/core";
import { readEnv } from "../config.js";

export const PRIORITY_MICROLAMPORTS = Number(readEnv("PRIORITY_FEE_MICROLAMPORTS") ?? 20_000);

export interface SendOpts {
  cu?: number;
  /** skipPreflight=true lands program rejections on-chain (open_round → /desk explorer link). */
  skipPreflight?: boolean;
  priorityMicroLamports?: number;
  pollMs?: number;
  resendMs?: number;
  /** Hard cap on the whole send (blockhash expiry normally ends it first, ~60–90 s). */
  deadlineMs?: number;
  alts?: AddressLookupTableAccount[];
  sleep?: (ms: number) => Promise<void>;
}

export class TxFailedError extends Error {
  constructor(public signature: string, public txErr: unknown, public logs: string[]) {
    super(`tx ${signature} failed on-chain: ${JSON.stringify(txErr)}`);
    this.name = "TxFailedError";
  }
}
export class TxExpiredError extends Error {
  constructor(public signature: string) {
    super(`tx ${signature} not confirmed before blockhash expiry (block height exceeded); retryable`);
    this.name = "TxExpiredError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildTx(payer: Keypair, ixs: TransactionInstruction[], signers: Signer[], blockhash: string, o: SendOpts = {}): VersionedTransaction {
  const isCb = (i: TransactionInstruction) => i.programId.equals(ComputeBudgetProgram.programId);
  const callerLimit = ixs.find((i) => isCb(i) && i.data[0] === 2); // SetComputeUnitLimit from a shared builder
  // Explicit `cu` wins; otherwise keep the caller's CU-limit ix (e.g. create_plan's Lend CPI budget), else 200k.
  const pre = [o.cu === undefined && callerLimit ? callerLimit : ComputeBudgetProgram.setComputeUnitLimit({ units: o.cu ?? 200_000 })];
  const price = o.priorityMicroLamports ?? PRIORITY_MICROLAMPORTS;
  if (price > 0) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  const body = ixs.filter((i) => !isCb(i));
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [...pre, ...body] }).compileToV0Message(o.alts ?? []);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers]);
  return tx;
}

/** Send and confirm ("confirmed"). Throws TxFailedError (landed, failed: has .signature/.logs), TxExpiredError, or preflight errors (.logs). */
export async function sendAndConfirm(connection: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Signer[] = [], o: SendOpts = {}): Promise<string> {
  const sleep = o.sleep ?? defaultSleep;
  const pollMs = o.pollMs ?? 1_500;
  const resendMs = o.resendMs ?? 4_000;
  const t0 = Date.now();
  const deadline = t0 + (o.deadlineMs ?? 100_000);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = buildTx(payer, ixs, signers, blockhash, o);
  const raw = tx.serialize();
  const sig = utils.bytes.bs58.encode(tx.signatures[0]!);
  try {
    await connection.sendRawTransaction(raw, { skipPreflight: !!o.skipPreflight, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (e) {
    if (e instanceof SendTransactionError) {
      const logs = (await e.getLogs(connection).catch(() => null)) ?? (e as any).logs ?? [];
      (e as any).logs = logs;
      throw e; // preflight rejection: nothing landed
    }
    // Network error on the first send: the tx may or may not have reached a leader — keep polling + re-sending.
  }
  let lastSend = Date.now();
  let checkedHeightAt = 0;
  for (;;) {
    await sleep(pollMs);
    const st = await connection.getSignatureStatuses([sig]).then((r) => r.value[0]).catch(() => undefined);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      if (!st.err) return sig;
      const info = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      throw new TxFailedError(sig, st.err, info?.meta?.logMessages ?? []);
    }
    if (Date.now() - lastSend >= resendMs) {
      lastSend = Date.now();
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    if (Date.now() - checkedHeightAt >= 5_000) {
      checkedHeightAt = Date.now();
      const h = await connection.getBlockHeight("confirmed").catch(() => null);
      if (h !== null && h > lastValidBlockHeight) {
        const fin = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true }).then((r) => r.value[0]).catch(() => null);
        if (fin && !fin.err) return sig;
        if (fin?.err) {
          const info = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
          throw new TxFailedError(sig, fin.err, info?.meta?.logMessages ?? []);
        }
        throw new TxExpiredError(sig);
      }
    }
    if (Date.now() > deadline) throw new TxExpiredError(sig);
  }
}
