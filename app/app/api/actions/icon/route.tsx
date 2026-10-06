import { ImageResponse } from "next/og";

export const dynamic = "force-static";

/** Square Blink card image in brand colours (no data — just the wordmark and line). */
export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 64,
          background: "#F9F8F3",
          color: "#1D2433",
        }}
      >
        <div style={{ display: "flex", fontSize: 72, fontFamily: "serif" }}>
          Bide<span style={{ color: "#1F6B57" }}>.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 64, lineHeight: 1.05, fontFamily: "serif" }}>Name your price.</div>
          <div style={{ fontSize: 64, lineHeight: 1.05, fontFamily: "serif", color: "#1F6B57" }}>Get paid until it fills.</div>
          <div style={{ fontSize: 26, color: "#5B6475", marginTop: 16 }}>SOL · Solana devnet</div>
        </div>
      </div>
    ),
    { width: 800, height: 800 },
  );
}
