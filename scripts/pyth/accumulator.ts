// VAA header/body inspection (guardian set index, signature count, emitter). Accumulator parsing lives in post.ts.
export function vaaInfo(vaa: Buffer) {
  const guardianSetIndex = vaa.readUInt32BE(1);
  const nSignatures = vaa[5];
  const body = vaa.subarray(6 + nSignatures * 66);
  return { guardianSetIndex, nSignatures, timestamp: body.readUInt32BE(0), emitterChain: body.readUInt16BE(8), emitter: body.subarray(10, 42).toString("hex") };
}
