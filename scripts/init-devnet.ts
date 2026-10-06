// One-shot devnet setup: init_config (agent = keeper, fee 10% → demo-user) + add_asset SOL. Idempotent.
// Usage: pnpm --filter @bide/scripts exec tsx init-devnet.ts
import { PublicKey } from "@solana/web3.js";
import { assetPda, configPda, PYTH_FEED_IDS, PYTH_PUSH_FEEDS, WSOL_MINT } from "@bide/shared";
import { client, exists, explorer, loadKeypair, send } from "./lib/chain.js";

const KEEPER = new PublicKey("CXeiLyivTuHns3tyhusJiLMudtzgbbxyAaNLGZjGuBPh");
const DEMO_USER = new PublicKey("6f7znmBfioj11fMmRTEnSC8xGgv2WTeHN9UpXo8fD3FY");

const SOL_PARAMS = {
  decimals: 9,
  pythFeedIdHex: PYTH_FEED_IDS.SOL_USD,
  spotFeed: PYTH_PUSH_FEEDS.SOL_USD,
  strikeTick: 100_000n, // $0.10
  maxConfBps: 50,
  maxSpotMoveBps: 50,
  // Devnet only: the sponsored push feed usually updates every 61–70 s but gaps of 227–320 s were seen on 6 Oct, which
  // left makers unable to take (StalePrice). 300 s is a weaker guard than mainnet's 30 s — stated in the README.
  maxSpotAgeSecs: 300,
  enabled: true,
};

async function main() {
  const admin = loadKeypair("deployer");
  if (!(await exists(configPda()[0]))) {
    console.log("init_config", explorer(await send([await client.initConfig(admin.publicKey, KEEPER, 1000, DEMO_USER)], [admin])));
  } else console.log("config exists");
  if (!(await exists(assetPda(WSOL_MINT)[0]))) {
    console.log("add_asset SOL", explorer(await send([await client.addAsset(admin.publicKey, WSOL_MINT, SOL_PARAMS)], [admin])));
  } else if (process.argv.includes("--update")) {
    // Keep every on-chain field as it is except max_spot_age_secs (no silent clobbering of later tuning).
    const cur = await client.fetchAsset(WSOL_MINT);
    const params = {
      ...SOL_PARAMS,
      spotFeed: cur.spotFeed, strikeTick: BigInt(cur.strikeTick.toString()), maxConfBps: cur.maxConfBps, maxSpotMoveBps: cur.maxSpotMoveBps,
      enabled: cur.enabled, pythFeedIdHex: Buffer.from(cur.pythFeedId).toString("hex"),
    };
    console.log("update_asset SOL", { maxSpotAgeSecs: `${cur.maxSpotAgeSecs} -> ${params.maxSpotAgeSecs}` });
    console.log("update_asset SOL", explorer(await send([await client.updateAsset(admin.publicKey, WSOL_MINT, params)], [admin])));
  } else console.log("SOL asset exists (pass --update to re-apply params)");
  const cfg = await client.fetchConfig();
  const a = await client.fetchAsset(WSOL_MINT);
  console.log("config:", { admin: cfg.admin.toBase58(), agent: cfg.agent.toBase58(), feeBps: cfg.feeBps, feeRecipient: cfg.feeRecipient.toBase58(), paused: cfg.paused });
  console.log("asset SOL:", { pda: assetPda(WSOL_MINT)[0].toBase58(), tick: a.strikeTick.toString(), spotFeed: a.spotFeed.toBase58(), lendFToken: a.lendFTokenMint.toBase58(), maxSpotAgeSecs: a.maxSpotAgeSecs });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
