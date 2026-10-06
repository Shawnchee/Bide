// Probe Hermes rate limit: wait out Retry-After, then send 1 req every `gapMs` until 429; report count + headers.
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
const H = { Authorization: `Bearer ${process.env.PYTH_HERMES_API_KEY}` };
const id = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const gapMs = Number(process.argv[2] ?? 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hit(t: number) {
  const r = await fetch(`https://hermes.pyth.network/v2/updates/price/${t}?ids[]=${id}&parsed=true`, { headers: H });
  return { status: r.status, retry: r.headers.get("retry-after"), body: r.status === 200 ? await r.json() : await r.text() };
}
let first = await hit(Math.floor(Date.now() / 1000) - 120);
if (first.status === 429) { console.log("waiting", first.retry, "s"); await sleep((Number(first.retry) + 1) * 1000); }
const t0 = Date.now(); let ok = 0;
for (let i = 0; i < 200; i++) {
  const r = await hit(Math.floor(Date.now() / 1000) - 120 - i);
  if (r.status !== 200) { console.log(`after ${ok} OK in ${(Date.now() - t0) / 1000}s at gap ${gapMs}ms → ${r.status} retry-after ${r.retry}`); process.exit(0); }
  ok++; await sleep(gapMs);
}
console.log(`${ok} OK in ${(Date.now() - t0) / 1000}s at gap ${gapMs}ms, no 429`);
