// Integration helper: watch the asset's sponsored Pyth push feed (asset.spot_feed) and log every new publish_time with
// the gap since the previous one. open_round / take_round fail with StalePrice when age > asset.max_spot_age_secs.
// Usage: tsx integration/feed-age.ts [--mins 30]
import { WSOL_MINT } from "@bide/shared";
import { client, connection } from "../lib/chain.js";
import { decodePriceUpdateV2 } from "../pyth/post.js";
const i = process.argv.indexOf("--mins"); const mins = i >= 0 ? Number(process.argv[i + 1]) : 30;
const a: any = await client.fetchAsset(WSOL_MINT);
let last = 0; const gaps: number[] = []; const end = Date.now() + mins * 60_000;
while (Date.now() < end) {
  try {
    const info = await connection.getAccountInfo(a.spotFeed);
    const pt = decodePriceUpdateV2(info!.data).publishTime;
    if (pt !== last) { if (last) gaps.push(pt - last); console.log(new Date(pt * 1000).toISOString(), last ? `gap ${pt - last}s` : "first", gaps.length ? `max ${Math.max(...gaps)}s >${a.maxSpotAgeSecs}s: ${gaps.filter((g) => g > a.maxSpotAgeSecs).length}/${gaps.length}` : ""); last = pt; }
  } catch (e) { console.log("read error", (e as Error).message.slice(0, 80)); }
  await new Promise((r) => setTimeout(r, 5000));
}
