// Integration helper: every Plan (side, status, kind, strikes, size, horizon) + every Std epoch (no secrets). Usage: tsx integration/plans.ts
import { client } from "../lib/chain.js";
const p = client.program as any;
const en = (v: any) => Object.keys(v ?? {})[0];
for (const x of await p.account.plan.all()) {
  const a = x.account;
  console.log(x.publicKey.toBase58(), en(a.side), en(a.status), a.quick ? "quick" : "std", "owner", a.owner.toBase58().slice(0, 6), "K", a.targetStrike.toString(), a.exitStrike.toString(), "size", a.sizeTotal.toString(), a.sizeFilled.toString(), "horizon", new Date(a.horizonEnd.toNumber() * 1000).toISOString(), "maxExp", a.maxExpirySecs, "minbps", a.minPremiumBpsPerDay);
}
for (const x of await p.account.epoch.all()) { const e = x.account; if (en(e.kind) === "std") console.log("epoch", x.publicKey.toBase58(), en(e.kind), en(e.status), new Date(e.expiry.toNumber() * 1000).toISOString()); }
