// Devnet backstop pool: init_pool (admin = deployer) + pool_deposit of USDC and wrapped SOL from the deployer. Idempotent init.
// Usage: cd scripts && ./node_modules/.bin/tsx init-pool.ts [--usdc 25] [--sol 0.5] [--no-deposit]
// Caps (BUILD §3.2 Pool): max premium 1.5 % of notional per round, 40 USDC open notional, 50 % utilisation, 2 USDC premium per day.
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PYTH_PUSH_FEEDS, USDC_MINT, WSOL_MINT } from "@bide/shared";
import { client, connection, exists, explorer, loadKeypair, send } from "./lib/chain.js";
import { decodePriceUpdateV2 } from "./pyth/post.js";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const POOL_PARAMS = {
  maxPremiumBpsOfNotional: 150,
  maxOpenNotional: 40_000_000n, // 40 USDC
  maxUtilizationBps: 5_000,
  spendWindowSecs: 86_400,
  spendWindowCap: 2_000_000n, // 2 USDC of premium per rolling day
};
const KEEP_SOL = 2;

async function feedAge(): Promise<number> {
  const a = await connection.getAccountInfo(PYTH_PUSH_FEEDS.SOL_USD);
  if (!a) throw new Error("push feed missing");
  return Math.floor(Date.now() / 1000) - decodePriceUpdateV2(a.data).publishTime;
}

/** pool_deposit reads spot from the push feed (StalePrice past max_spot_age_secs): wait for a reasonably fresh update. */
async function waitFreshFeed(maxAge: number) {
  for (let i = 0; i < 60; i++) {
    const age = await feedAge();
    if (age <= maxAge) return age;
    console.log(`push feed ${age}s old, waiting…`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("push feed stayed stale for 10 min");
}

async function main() {
  const admin = loadKeypair("deployer");
  const a = client.poolAccounts();
  if (!(await exists(a.pool))) {
    const sig = await send(await client.initPool(admin.publicKey, POOL_PARAMS), [admin]);
    console.log("init_pool", explorer(sig));
  } else console.log("pool exists", a.pool.toBase58());

  if (!process.argv.includes("--no-deposit")) {
    const usdc = BigInt(Math.round(arg("usdc", 25) * 1e6));
    const lamports = BigInt(Math.round(arg("sol", 0.5) * LAMPORTS_PER_SOL));
    const bal = await connection.getBalance(admin.publicKey);
    if (bal - Number(lamports) < KEEP_SOL * LAMPORTS_PER_SOL) throw new Error(`deployer would drop below ${KEEP_SOL} SOL (has ${bal / LAMPORTS_PER_SOL})`);
    const asset = await client.fetchAsset(WSOL_MINT);
    const age = await waitFreshFeed(asset.maxSpotAgeSecs - 30);
    console.log(`push feed age ${age}s (max ${asset.maxSpotAgeSecs})`);
    if (usdc > 0n) {
      const sig = await send(await client.poolDeposit(admin.publicKey, USDC_MINT, usdc), [admin]);
      console.log(`pool_deposit USDC ${Number(usdc) / 1e6}`, explorer(sig));
    }
    if (lamports > 0n) {
      const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, admin.publicKey);
      const wrap = [
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, wsolAta, admin.publicKey, WSOL_MINT),
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wsolAta, lamports }),
        createSyncNativeInstruction(wsolAta),
      ];
      const sig = await send([...wrap, ...(await client.poolDeposit(admin.publicKey, WSOL_MINT, lamports))], [admin]);
      console.log(`wrap + pool_deposit WSOL ${Number(lamports) / 1e9}`, explorer(sig));
    }
  }

  const p = await client.program.account.pool.fetch(a.pool);
  const [u, w] = await Promise.all([connection.getTokenAccountBalance(a.poolUsdc), connection.getTokenAccountBalance(a.poolWsol)]);
  console.log("pool:", {
    pda: a.pool.toBase58(), authority: p.authority.toBase58(), paused: p.paused,
    maxPremiumBpsOfNotional: p.maxPremiumBpsOfNotional, maxOpenNotional: p.maxOpenNotional.toString(), maxUtilizationBps: p.maxUtilizationBps,
    spendWindowSecs: p.spendWindowSecs, spendWindowCap: p.spendWindowCap.toString(), openNotional: p.openNotional.toString(),
    usdcVault: u.value.uiAmountString, wsolVault: w.value.uiAmountString,
  });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
