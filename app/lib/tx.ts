// Single entry point for building the create_plan transaction (BUILD §3.3 #4, §6).
// One signature: [compute budget 400k] + [Sell: wrap SOL → WSOL] + create_plan (+ Lend CPI accounts),
// compiled as a v0 transaction with the Lend address lookup table when the P lane publishes it.

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { parseBideError } from "@bide/shared";
import { wrapSolIxs } from "./wrap";
import { LEND_ALT } from "./env";
import { LEND_CU_LIMIT, WSOL_MINT, type AssetInfo } from "./constants";
import { getBideClient, PROGRAM_NOT_READY, type DecodedRound } from "./bide-client";
import type { Draft } from "./plan-math";

export class ProgramNotReadyError extends Error {
  constructor() {
    super(PROGRAM_NOT_READY);
  }
}

async function lookupTables(conn: Connection): Promise<AddressLookupTableAccount[]> {
  if (!LEND_ALT) return [];
  const res = await conn.getAddressLookupTable(new PublicKey(LEND_ALT));
  return res.value ? [res.value] : [];
}

export async function compileV0(
  conn: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  opts: { cuLimit?: number } = {},
): Promise<VersionedTransaction> {
  // P's builders already add a CU-limit ix for Lend CPIs; never add a second one (duplicate = tx error).
  const hasCu = ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  const all = [...(opts.cuLimit && !hasCu ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit })] : []), ...ixs];
  const [{ blockhash }, alts] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToV0Message(alts);
  return new VersionedTransaction(msg);
}

export async function buildCreatePlanTx(
  conn: Connection,
  owner: PublicKey,
  asset: AssetInfo,
  draft: Draft,
): Promise<VersionedTransaction> {
  const client = getBideClient(conn);
  if (!client) throw new ProgramNotReadyError();
  const pre: TransactionInstruction[] = [];
  // Sell plans on SOL lock WSOL: wrap native SOL in the same transaction.
  if (!draft.lockIsUsdc && asset.mint.equals(WSOL_MINT)) pre.push(...wrapSolIxs(owner, draft.lockAmount));
  const planIxs = await client.createPlanIxs({ conn, owner, asset, args: draft.args });
  return compileV0(conn, owner, [...pre, ...planIxs], { cuLimit: LEND_CU_LIMIT });
}

export async function buildTakeRoundTx(conn: Connection, maker: PublicKey, round: DecodedRound) {
  const client = getBideClient(conn);
  if (!client) throw new ProgramNotReadyError();
  return compileV0(conn, maker, await client.takeRoundIxs({ conn, maker, round }), { cuLimit: 200_000 });
}

export async function buildPausePlanTx(conn: Connection, owner: PublicKey, plan: PublicKey, paused: boolean) {
  const client = getBideClient(conn);
  if (!client) throw new ProgramNotReadyError();
  return compileV0(conn, owner, [await client.pausePlanIx({ owner, plan, paused })]);
}

export async function buildClosePlanTx(conn: Connection, owner: PublicKey, plan: PublicKey) {
  const client = getBideClient(conn);
  if (!client) throw new ProgramNotReadyError();
  return compileV0(conn, owner, await client.closePlanIxs({ conn, owner, plan }), { cuLimit: LEND_CU_LIMIT });
}

export async function buildPoolTx(
  conn: Connection,
  lp: PublicKey,
  action: { kind: "deposit"; mint: PublicKey; amount: bigint } | { kind: "withdraw"; shares: bigint },
) {
  const client = getBideClient(conn);
  if (!client || !client.poolDepositIxs || !client.poolWithdrawIxs) throw new ProgramNotReadyError();
  const ixs =
    action.kind === "deposit"
      ? await client.poolDepositIxs({ conn, lp, mint: action.mint, amount: action.amount })
      : await client.poolWithdrawIxs({ conn, lp, shares: action.shares });
  return compileV0(conn, lp, ixs, { cuLimit: LEND_CU_LIMIT });
}

/** Map a failed tx / simulation to a human sentence. Program error names follow BUILD §3.4. */
export function explainTxError(e: unknown): { message: string; cancelled: boolean } {
  const raw = e instanceof Error ? e.message : String(e);
  if (/reject|cancel|denied|declined/i.test(raw)) return { message: "You cancelled in your wallet. Nothing was sent.", cancelled: true };
  if (e instanceof ProgramNotReadyError) return { message: raw, cancelled: false };
  if (/blockhash/i.test(raw)) return { message: "The network was busy. Try again.", cancelled: false };
  // Only the real insufficient-balance cases: SPL Token / Token-2022 InsufficientFunds (custom error 0x1 *from the token
  // program*) or the system program's lamports message. A bare 0x1 from any other program is not a balance problem (A-L1).
  const err = e as { logs?: string[]; transactionLogs?: string[] } | null;
  const logs = [raw, ...((err && (err.logs ?? err.transactionLogs)) || [])].join("\n");
  const splInsufficient = /Program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) failed: custom program error: 0x1\b/.test(logs);
  if (/insufficient (funds|lamports)/i.test(logs) || splInsufficient)
    return { message: "Not enough balance in your wallet for this amount plus network fees.", cancelled: false };
  const bideErr = parseBideError(e);
  const named: Record<string, string> = {
    HorizonOutOfRange: "That deadline is outside the allowed range (1 day to 6 months).",
    AssetDisabled: "This asset is paused right now.",
    StrikeOffTick: "That price isn't on the allowed price grid. Pick a price in the shown steps.",
    ZeroAmount: "Enter an amount above zero.",
    Paused: "Bide is paused right now. Your funds were not moved.",
    AuctionOver: "Too late — this auction already ended.",
    WrongStatus: "This round isn't open any more.",
    SpotMovedTooMuch: "The price moved too much since the auction opened. Try the next one.",
    StalePrice: "The price feed is stale right now. Try again in a few minutes.",
    SettlementPending: "A settlement is still being paid out. Try again shortly.",
  };
  if (bideErr === "NotImplemented") return { message: "This action ships in the next program upgrade. Nothing was sent.", cancelled: false };
  if (bideErr && named[bideErr]) return { message: named[bideErr], cancelled: false };
  for (const [k, v] of Object.entries(named)) if (raw.includes(k)) return { message: v, cancelled: false };
  if (bideErr) return { message: `The program rejected this (${bideErr}). Nothing was moved.`, cancelled: false };
  return { message: "The transaction failed. Nothing was charged except possibly the network fee.", cancelled: false };
}
