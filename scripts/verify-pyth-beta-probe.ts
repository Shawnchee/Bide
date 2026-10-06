import { config } from "dotenv";
config({ path: "/Users/shawnchee/Desktop/projects/deeznuts/.env" });
const H = { Authorization: `Bearer ${process.env.PYTH_HERMES_API_KEY}` };
for (const url of [
  "https://hermes-beta.pyth.network/v2/price_feeds?query=SOL&asset_type=crypto",
  "https://hermes-beta.pyth.network/v2/price_feeds?query=BTC&asset_type=crypto",
  "https://hermes-beta.pyth.network/api/latest_price_feeds?ids[]=ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
]) {
  for (const auth of [false, true]) {
    const r = await fetch(url, { headers: auth ? H : {} });
    const t = await r.text();
    let out = t.slice(0, 200);
    try { const j = JSON.parse(t); if (Array.isArray(j)) out = JSON.stringify(j.filter((f:any)=>/^Crypto\.(SOL|BTC)\/USD$/.test(f.attributes?.symbol)).map((f:any)=>[f.id,f.attributes.symbol])) + ` (total ${j.length})`; } catch {}
    console.log(auth ? "AUTH" : "NOAUTH", r.status, url.slice(29), out);
  }
}
