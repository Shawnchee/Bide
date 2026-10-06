// One-shot: grow the devnet Pool account to the v2 layout (per-kind open sums) after the 2026-10-07 program upgrade.
// Admin = deployer. Refuses to run twice (WrongStatus on an already-migrated pool). Usage: cd scripts && ./node_modules/.bin/tsx migrate-pool.ts
import { client, connection, explorer, loadKeypair, send } from "./lib/chain.js";

async function main() {
  const admin = loadKeypair("deployer");
  const pool = client.poolAccounts().pool;
  const before = await connection.getAccountInfo(pool);
  if (!before) throw new Error("pool not initialised");
  console.log(`pool ${pool.toBase58()} size before: ${before.data.length}`);
  if (before.data.length !== 148) {
    console.log("already migrated (or unexpected size); nothing to do");
    return;
  }
  const sig = await send([await client.migratePool(admin.publicKey)], [admin]);
  console.log("migrate_pool", explorer(sig));
  const after = await connection.getAccountInfo(pool);
  console.log(`size after: ${after?.data.length}`);
  const p = await (client as unknown as { program: { account: { pool: { fetch(k: typeof pool): Promise<Record<string, { toString(): string }>> } } } }).program.account.pool.fetch(pool);
  console.log("pool decodes:", {
    openNotional: p.openNotional.toString(),
    putOpenSize: p.putOpenSize.toString(),
    putOpenNotional: p.putOpenNotional.toString(),
    callOpenNotional: p.callOpenNotional.toString(),
    callOpenSize: p.callOpenSize.toString(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
