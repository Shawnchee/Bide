// Task 2 probe: auth, latest, historical endpoint semantics on hermes-beta + hermes.
import "dotenv/config";
import { config } from "dotenv";
import { HERMES_BETA, HERMES_MAINNET, FEED_IDS, getLatest, getAt } from "./pyth/hermes.js";
config({ path: new URL("../.env", import.meta.url).pathname });

const id = FEED_IDS.SOL_USD;
for (const base of [HERMES_BETA, HERMES_MAINNET]) {
  const noAuth = await getLatest(base, [id], false);
  const latest = await getLatest(base, [id]);
  const p = latest.parsed?.[0];
  console.log(base, "noauth", noAuth.status, "auth", latest.status, "publish_time", p?.price.publish_time,
    "price", p?.price.price, "expo", p?.price.expo, "now", Math.floor(Date.now() / 1000), "meta", JSON.stringify(p?.metadata));
  if (!p) { console.log(latest.raw); continue; }
  const t0 = p.price.publish_time - 120;
  for (const t of [t0, t0 + 1, t0 + 2, t0 + 3, p.price.publish_time - 3600, p.price.publish_time - 86400 * 2]) {
    const r = await getAt(base, [id], t);
    const pp = r.parsed?.[0];
    console.log("  at", t, "->", r.status, pp?.price.publish_time, "delta", pp ? pp.price.publish_time - t : null,
      "prev", pp?.metadata?.prev_publish_time, "price", pp?.price.price, r.raw ?? "");
  }
}
