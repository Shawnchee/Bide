// Integration: owner closes an idle plan (returns collateral + rent). Usage: tsx integration/close-plan.ts --plan <PK> [--owner deployer]
import { PublicKey } from "@solana/web3.js";
import { BIDE_ALT } from "@bide/shared";
import { client, connection, explorer, loadKeypair, send } from "../lib/chain.js";
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const owner = loadKeypair(arg("owner", "deployer")!);
const plan = new PublicKey(arg("plan")!);
const p = await client.fetchPlan(plan);
const alt = (await connection.getAddressLookupTable(BIDE_ALT)).value!;
const sig = await send(await client.closePlan(owner.publicKey, plan, p, false), [owner], alt);
console.log("close_plan", plan.toBase58(), explorer(sig));
