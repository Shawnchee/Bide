import { createHash } from "node:crypto";

/**
 * Canonical JSON for memo hashing.
 *  - Object keys sorted by UTF-16 code unit order (Array.prototype.sort default), at every level.
 *  - `undefined` object values are dropped; `undefined` in arrays → null (JSON.stringify rule).
 *  - Integers: must be safe integers, written in plain decimal.
 *  - Non-integer numbers: rounded to 6 decimal places, then written with JS shortest round-trip
 *    formatting (no exponent for |x| ≥ 1e-6 … 1e21). -0 → 0. NaN / ±Infinity → throw.
 *  - bigint → decimal string. Uint8Array → lowercase hex string. Date → ISO string.
 *  - No whitespace.
 * The memo stored in the DB is `JSON.parse(canonicalJson(memo))`, so re-hashing the stored
 * memo reproduces the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

const FLOAT_DECIMALS = 6;

function writeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) throw new Error(`canonicalJson: non-finite number at ${path}`);
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n)) throw new Error(`canonicalJson: unsafe integer at ${path} (use a string)`);
    return Object.is(n, -0) ? "0" : String(n);
  }
  const f = 10 ** FLOAT_DECIMALS;
  let r = Math.round(n * f) / f;
  if (Object.is(r, -0)) r = 0;
  const s = JSON.stringify(r);
  if (/e/i.test(s)) throw new Error(`canonicalJson: number out of range for fixed formatting at ${path}`);
  return s;
}

function write(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return writeNumber(v, path);
    case "bigint":
      return JSON.stringify(v.toString());
    case "object": {
      if (v instanceof Uint8Array) return JSON.stringify(Buffer.from(v).toString("hex"));
      if (v instanceof Date) return JSON.stringify(v.toISOString());
      if (Array.isArray(v)) return "[" + v.map((x, i) => (x === undefined || typeof x === "function" ? "null" : write(x, `${path}[${i}]`))).join(",") + "]";
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && typeof obj[k] !== "function").sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + write(obj[k], `${path}.${k}`)).join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v} at ${path}`);
  }
}

/** Round-trip through canonical form: what the DB will hold. */
export function normalizeForMemo<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function sha256Bytes(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text, "utf8").digest());
}

export function memoHash(memo: unknown): { json: string; hash: Uint8Array; hex: string } {
  const json = canonicalJson(memo);
  const hash = sha256Bytes(json);
  return { json, hash, hex: Buffer.from(hash).toString("hex") };
}
