// Integration helper: plan + its rounds + an epoch + owner token balances; and per-tx token deltas (no secrets).
// Usage: tsx integration/inspect.ts --plan <PK> [--epoch <PK>] [--tx <sig> ...]
import { PublicKey } from "@solana/web3.js";
import { ata, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { client, connection } from "../lib/chain.js";

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const p = client.program as any;
const s = (v: any) => (v?.toBase58 ? v.toBase58() : v?.toString?.() ?? v);
const en = (v: any) => Object.keys(v ?? {})[0];

if (arg("plan")) {
  const pk = new PublicKey(arg("plan")!);
  const a = await p.account.plan.fetchNullable(pk);
  if (!a) console.log("plan closed/absent", pk.toBase58());
  else {
    console.log("plan", pk.toBase58(), { side: en(a.side), phase: en(a.phase), status: en(a.status), quick: a.quick, sizeTotal: s(a.sizeTotal), sizeFilled: s(a.sizeFilled),
      collateralPrincipal: s(a.collateralPrincipal), lendShares: s(a.lendShares), activeRound: s(a.activeRound), pending: s(a.pendingSettlement), roundCount: a.roundCount });
    const tok = async (m: PublicKey) => (await connection.getTokenAccountBalance(ata(m, a.owner)).catch(() => null))?.value.amount ?? "-";
    console.log("owner", a.owner.toBase58(), { usdc: await tok(USDC_MINT), wsol: await tok(WSOL_MINT), sol: (await connection.getBalance(a.owner)) / 1e9 });
  }
  const rounds = await p.account.round.all([{ memcmp: { offset: 8, bytes: pk.toBase58() } }]).catch(() => []);
  for (const r of rounds) console.log("round", r.publicKey.toBase58(), { status: en(r.account.status), strike: s(r.account.strike), size: s(r.account.size), premiumPaid: s(r.account.premiumPaid), feePaid: s(r.account.feePaid), exercised: r.account.exercised, settle: s(r.account.settlePrice), maker: s(r.account.maker) });
}
if (arg("epoch")) {
  const e = await p.account.epoch.fetch(new PublicKey(arg("epoch")!));
  console.log("epoch", arg("epoch"), { kind: en(e.kind), status: en(e.status), expiry: new Date(e.expiry.toNumber() * 1000).toISOString(), mask: e.sampleMask, settle: s(e.settlePrice), samples: e.samples.map(s) });
}
for (let i = 0; i < args.length; i++) if (args[i] === "--tx") {
  const sig = args[i + 1]!;
  const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const keys = t?.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses }) as any;
  const pre = new Map((t?.meta?.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const deltas = (t?.meta?.postTokenBalances ?? []).map((b) => {
    const before = BigInt(pre.get(b.accountIndex)?.uiTokenAmount.amount ?? "0");
    return { owner: b.owner, mint: b.mint.slice(0, 6), delta: (BigInt(b.uiTokenAmount.amount) - before).toString() };
  }).filter((d) => d.delta !== "0");
  console.log("tx", sig.slice(0, 12), { time: t?.blockTime ? new Date(t.blockTime * 1000).toISOString() : "?", err: JSON.stringify(t?.meta?.err), deltas });
  void keys;
}
