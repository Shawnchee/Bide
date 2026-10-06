import type { Connection, PublicKey } from "@solana/web3.js";

export interface PythSpot {
  price: number; // dollars
  conf: number; // dollars
  publishTime: number; // unix seconds
  verification: "full" | "partial";
}

/**
 * Decode a Pyth `PriceUpdateV2` account (pyth-solana-receiver-sdk layout):
 * disc[8] · write_authority[32] · verification_level (enum: Partial{u8} | Full) ·
 * feed_id[32] · price i64 · conf u64 · exponent i32 · publish_time i64 · …
 */
export function decodePriceUpdateV2(data: Uint8Array): PythSpot {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32;
  const tag = data[o];
  o += 1;
  let verification: PythSpot["verification"] = "full";
  if (tag === 0) {
    verification = "partial";
    o += 1; // num_signatures
  }
  o += 32; // feed_id
  const price = view.getBigInt64(o, true);
  o += 8;
  const conf = view.getBigUint64(o, true);
  o += 8;
  const expo = view.getInt32(o, true);
  o += 4;
  const publishTime = Number(view.getBigInt64(o, true));
  const scale = 10 ** expo;
  return { price: Number(price) * scale, conf: Number(conf) * scale, publishTime, verification };
}

/** Read the sponsored push feed on devnet (updates every ~5 min — BUILD §3.7). */
export async function fetchPushFeedSpot(conn: Connection, feed: PublicKey): Promise<PythSpot | null> {
  const info = await conn.getAccountInfo(feed, "confirmed");
  if (!info) return null;
  return decodePriceUpdateV2(info.data);
}
