import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, memoHash, normalizeForMemo } from "./canonical.js";

test("canonical JSON sorts keys at every level and drops undefined", () => {
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, u: undefined });
  assert.equal(a, '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test("hash is independent of key insertion order", () => {
  const x = memoHash({ a: 1, b: { c: 2, d: 3 } });
  const y = memoHash({ b: { d: 3, c: 2 }, a: 1 });
  assert.equal(x.hex, y.hex);
  assert.equal(x.hash.length, 32);
});

test("known vector: sha256 of canonical bytes is pinned", () => {
  const { json, hex } = memoHash({ z: "é", a: [1, 0.5, -0, true, null] });
  assert.equal(json, '{"a":[1,0.5,0,true,null],"z":"é"}');
  // sha256 of the UTF-8 bytes above, computed independently with `shasum -a 256`
  assert.equal(hex, "b5c31d67ec8c6d1031026accdc7973a5fb9c7b08a296cba46d3105bac42eba85");
});

test("floats are rounded to 6 dp; re-hashing the normalised memo is stable", () => {
  const memo = { p: 0.123456789, q: 1 / 3, r: 2.5e-7 };
  assert.equal(canonicalJson(memo), '{"p":0.123457,"q":0.333333,"r":0}');
  const stored = normalizeForMemo(memo);
  assert.equal(memoHash(stored).hex, memoHash(memo).hex);
});

test("bigint → string, Uint8Array → hex, rejects NaN and unsafe ints", () => {
  assert.equal(canonicalJson({ v: 18446744073709551615n, b: new Uint8Array([1, 255]) }), '{"b":"01ff","v":"18446744073709551615"}');
  assert.throws(() => canonicalJson({ x: NaN }));
  assert.throws(() => canonicalJson({ x: 2 ** 60 }));
});
