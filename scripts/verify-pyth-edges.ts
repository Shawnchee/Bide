// Edge cases of /v2/updates/price/{t}: future, just-now, old, very old.
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { HERMES_MAINNET, FEED_IDS, getAt } from "./pyth/hermes.js";
const now = Math.floor(Date.now() / 1000);
for (const [label, t] of [["now+30", now + 30], ["now-1", now - 1], ["now-3", now - 3], ["30d", now - 30 * 86400], ["180d", now - 180 * 86400], ["400d", now - 400 * 86400]] as const) {
  const r = await getAt(HERMES_MAINNET, [FEED_IDS.SOL_USD], t);
  console.log(label, t, "HTTP", r.status, "pt", r.parsed?.[0]?.price.publish_time, r.raw?.slice(0, 120) ?? "");
  await new Promise((s) => setTimeout(s, 1200));
}
