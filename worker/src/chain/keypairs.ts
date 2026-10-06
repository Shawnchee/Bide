// Keypair loading. Env value may be a JSON byte array, a base58 secret, or (local dev only) a path to a
// keys/*.json file. Never log the value — only the public key.
import { Keypair } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { utils } from "@anchor-lang/core";
import { readEnv } from "../config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function parseKeypair(v: string): Keypair {
  const s = v.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  const asPath = path.isAbsolute(s) ? s : path.resolve(repoRoot, s);
  if ((s.endsWith(".json") || s.includes("/")) && existsSync(asPath)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(asPath, "utf8"))));
  }
  return Keypair.fromSecretKey(utils.bytes.bs58.decode(s));
}

/** Returns undefined if the env var is EMPTY; throws (without echoing the value) if it is malformed. */
export function loadKeypair(envName: string): Keypair | undefined {
  const v = readEnv(envName);
  if (!v) return undefined;
  try { return parseKeypair(v); }
  catch { throw new Error(`${envName} is SET but not a valid keypair (JSON array, base58, or keys/*.json path)`); }
}

export function loadMakerKeypairs(): { name: string; kp: Keypair }[] {
  return (["MAKER1_KEYPAIR", "MAKER2_KEYPAIR", "MAKER3_KEYPAIR"] as const)
    .map((n, i) => ({ name: `maker-${i + 1}`, kp: loadKeypair(n) }))
    .filter((x): x is { name: string; kp: Keypair } => !!x.kp);
}
