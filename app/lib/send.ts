import type { Connection, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

type Wallet = Pick<WalletContextState, "sendTransaction" | "signTransaction">;

/**
 * Sign in the wallet, send through our own RPC, and wait for "confirmed" (polls; 60 s cap).
 * Signing only (not the wallet's sign-and-send) keeps sending off the wallet's own devnet RPC, which failed with a bare
 * "Unexpected error", and our preflight returns the program logs that explainTxError reads.
 */
export async function sendAndConfirm(
  conn: Connection,
  wallet: Wallet,
  tx: VersionedTransaction,
  onStage?: (s: "signing" | "confirming") => void,
): Promise<string> {
  onStage?.("signing");
  let sig: string;
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } else {
    sig = await wallet.sendTransaction(tx, conn, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  }
  onStage?.("confirming");
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("Timed out waiting for confirmation. Check the explorer before retrying.");
}
