// LiteSVM harness loaded with REAL devnet program binaries + accounts (tests/fixtures, from scripts/dump-fixtures.sh).
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiteSVM, Clock, FailedTransactionMetadata, TransactionMetadata } from "litesvm";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AccountLayout, ACCOUNT_SIZE, createSyncNativeInstruction } from "@solana/spl-token";
import { PROGRAM_ID, TOKEN_PROGRAM_ID, ata, WSOL_MINT, USDC_MINT, BideClient, parseBideError } from "@bide/shared";
import { Connection } from "@solana/web3.js";

const req = createRequire(createRequire(import.meta.url).resolve("litesvm"));
const kit = req("@solana/kit");

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const FIX = join(ROOT, "tests", "fixtures");

export const addr = (pk: PublicKey) => pk.toBase58() as never;

export class Env {
  svm: LiteSVM;
  client: BideClient;
  dumpedAt: number;
  constructor() {
    if (!existsSync(join(FIX, "programs"))) throw new Error("run scripts/dump-fixtures.sh first");
    this.svm = new LiteSVM().withSysvars().withBuiltins().withDefaultPrograms().withPrecompiles().withNativeMints().withLogBytesLimit(100_000n);
    for (const f of readdirSync(join(FIX, "programs"))) {
      const id = f.replace(/\.so$/, "");
      this.svm.addProgramFromFile(id as never, join(FIX, "programs", f));
    }
    for (const f of readdirSync(join(FIX, "accounts"))) {
      const j = JSON.parse(readFileSync(join(FIX, "accounts", f), "utf8"));
      this.loadAccountJson(j);
    }
    this.svm.addProgramFromFile(addr(PROGRAM_ID), process.env.BIDE_SO || join(ROOT, "target", "deploy", "bide.so"));
    this.dumpedAt = Number(readFileSync(join(FIX, "dumped_at"), "utf8").trim());
    this.client = new BideClient(new Connection("http://127.0.0.1:1")); // only used to build instructions/decode
    this.setTime(this.dumpedAt + 60);
  }

  loadAccountJson(j: { pubkey: string; account: { lamports: number; data: [string, string]; owner: string; executable: boolean } }) {
    this.svm.setAccount({
      address: j.pubkey as never,
      lamports: BigInt(j.account.lamports) as never,
      data: Buffer.from(j.account.data[0], "base64"),
      programAddress: j.account.owner as never,
      executable: j.account.executable,
      space: BigInt(Buffer.from(j.account.data[0], "base64").length),
    } as never);
  }

  now(): number {
    return Number(this.svm.getClock().unixTimestamp);
  }

  /** Clock must only move forward (Lend accrues from its last_update_timestamp). */
  setTime(unix: number) {
    const c = this.svm.getClock();
    const slot = c.slot + 1n + BigInt(Math.max(0, unix - Number(c.unixTimestamp))) * 2n;
    this.svm.setClock(new Clock(slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(unix)));
    this.svm.expireBlockhash();
  }
  warp(secs: number) {
    this.setTime(this.now() + secs);
  }

  setRaw(pubkey: PublicKey, data: Buffer, owner: PublicKey, lamports?: bigint) {
    this.svm.setAccount({
      address: addr(pubkey),
      lamports: (lamports ?? this.svm.minimumBalanceForRentExemption(BigInt(data.length))) as never,
      data,
      programAddress: addr(owner),
      executable: false,
      space: BigInt(data.length),
    } as never);
  }

  getData(pubkey: PublicKey): Buffer | null {
    const a = this.svm.getAccount(addr(pubkey)) as { exists: boolean; data?: Uint8Array };
    return a.exists ? Buffer.from(a.data!) : null;
  }
  lamports(pubkey: PublicKey): bigint {
    return BigInt((this.svm.getBalance(addr(pubkey)) as unknown as bigint) ?? 0n);
  }

  newWallet(sol = 10): Keypair {
    const kp = Keypair.generate();
    this.svm.airdrop(addr(kp.publicKey), BigInt(sol * LAMPORTS_PER_SOL) as never);
    return kp;
  }

  /** Test-state setup: write an SPL token account (ATA address) with `amount`. Not a program mock. */
  setTokenBalance(mint: PublicKey, owner: PublicKey, amount: bigint): PublicKey {
    const a = ata(mint, owner);
    const buf = Buffer.alloc(ACCOUNT_SIZE);
    const isNative = mint.equals(WSOL_MINT);
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE));
    AccountLayout.encode(
      {
        mint,
        owner,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: isNative ? 1 : 0,
        isNative: isNative ? rent : 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      buf,
    );
    this.setRaw(a, buf, TOKEN_PROGRAM_ID, isNative ? rent + amount : rent);
    return a;
  }

  tokenBalance(acc: PublicKey): bigint {
    const d = this.getData(acc);
    if (!d) return 0n;
    return AccountLayout.decode(d).amount;
  }

  /** Real wrap of SOL: system transfer + sync_native into the owner's WSOL ATA (must exist). */
  wrapIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
    const a = ata(WSOL_MINT, owner);
    return [SystemProgram.transfer({ fromPubkey: owner, toPubkey: a, lamports }), createSyncNativeInstruction(a)];
  }

  alt: AddressLookupTableAccount | null = null;

  /** Fixture ALT inside LiteSVM (same address set as the devnet BIDE_ALT); state serialized by hand. */
  installAlt(addresses: PublicKey[]): AddressLookupTableAccount {
    const key = Keypair.generate().publicKey;
    const meta = Buffer.alloc(56);
    meta.writeUInt32LE(1, 0); // ProgramState::LookupTable
    meta.writeBigUInt64LE(0xffffffffffffffffn, 4); // deactivation_slot
    meta.writeBigUInt64LE(0n, 12); // last_extended_slot
    meta[20] = 0;
    meta[21] = 0; // authority: None
    const data = Buffer.concat([meta, ...addresses.map((a) => a.toBuffer())]);
    this.setRaw(key, data, new PublicKey("AddressLookupTab1e1111111111111111111111111"));
    this.alt = new AddressLookupTableAccount({
      key,
      state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
    });
    return this.alt;
  }

  send(ixs: TransactionInstruction[], signers: Keypair[], useAlt = false): TransactionMetadata {
    let bytes: Uint8Array;
    if (useAlt && this.alt) {
      const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: this.svm.latestBlockhash() as unknown as string, instructions: ixs }).compileToV0Message([this.alt]);
      const vtx = new VersionedTransaction(msg);
      vtx.sign(signers);
      bytes = vtx.serialize();
    } else {
      const tx = new Transaction();
      tx.recentBlockhash = this.svm.latestBlockhash() as unknown as string;
      tx.feePayer = signers[0].publicKey;
      tx.add(...ixs);
      tx.sign(...signers);
      bytes = tx.serialize();
    }
    const ktx = kit.getTransactionDecoder().decode(bytes);
    const res = this.svm.sendTransaction(ktx);
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) {
      const logs = res.meta().logs();
      const e = new Error(`tx failed: ${String(res.err())}\n${logs.filter((l) => !/^Program (Tokenkeg|11111|ComputeBudget|AToken)|consumed|success$/.test(l)).slice(-25).join("\n")}`) as Error & { logs: string[]; bideError: string | null };
      e.logs = logs;
      e.bideError = parseBideError({ message: e.message, logs });
      throw e;
    }
    return res;
  }

  /** Expect a tx to fail with a given Bide error name (or any substring of the logs). */
  expectFail(ixs: TransactionInstruction[], signers: Keypair[], want: string, useAlt = false) {
    try {
      this.send(ixs, signers, useAlt);
    } catch (e) {
      const err = e as Error & { bideError: string | null };
      if (err.bideError === want || err.message.includes(want)) return err;
      throw new Error(`expected ${want}, got ${err.bideError}: ${err.message.slice(0, 4000)}`);
    }
    throw new Error(`expected failure ${want}, but tx succeeded`);
  }

  decode<T>(name: "plan" | "round" | "epoch" | "config" | "asset" | "pool", pubkey: PublicKey): T {
    const d = this.getData(pubkey);
    if (!d) throw new Error(`account ${pubkey.toBase58()} missing`);
    return this.client.program.coder.accounts.decode(name, d) as T;
  }
  exists(pubkey: PublicKey): boolean {
    const d = this.getData(pubkey);
    return d !== null && d.length > 0;
  }
}

export { USDC_MINT, WSOL_MINT };
