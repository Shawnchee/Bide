import type { Connection, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/** Send through the connected wallet and wait for "confirmed" (polls; 60 s cap). */
export async function sendAndConfirm(
  conn: Connection,
  send: WalletContextState["sendTransaction"],
  tx: VersionedTransaction,
  onStage?: (s: "signing" | "confirming") => void,
): Promise<string> {
  onStage?.("signing");
  const sig = await send(tx, conn, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
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
