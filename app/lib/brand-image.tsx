import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

/** Embed the local mark so share cards do not depend on a public site URL. */
export async function brandImage(width: number, height: number) {
  const mark = await readFile(path.join(process.cwd(), "public/brand/bide-mark.png"));
  const square = width === height;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#090d10", color: "#e6ebf1", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 64, fontWeight: 600 }}>
          {/* ImageResponse renders embedded images directly. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/png;base64,${mark.toString("base64")}`} alt="" width={80} height={80} />
          Bide
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: square ? 60 : 64, lineHeight: 1.1 }}>Name your price.</div>
          <div style={{ fontSize: square ? 60 : 64, lineHeight: 1.1, color: "#62e3b6" }}>Get paid until it fills.</div>
          <div style={{ fontSize: 26, color: "#90a1b9", marginTop: 20 }}>SOL · Solana devnet</div>
        </div>
      </div>
    ),
    { width, height },
  );
}
