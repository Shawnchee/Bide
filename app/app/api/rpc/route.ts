export const dynamic = "force-dynamic";

// Browser JSON-RPC goes through here so the keyed devnet RPC (HELIUS_RPC_URL) stays server-side. Public devnet RPC
// rate-limits a shared IP (429), which left /earn with no spot price.
const UPSTREAM = process.env.HELIUS_RPC_URL || "https://api.devnet.solana.com";
const MAX_BODY = 256 * 1024;
const MAX_BATCH = 20;
// Reads, simulation and sending a wallet-signed transaction. Nothing that spends the RPC owner's funds (no airdrop).
const ALLOWED = /^(get[A-Za-z]+|simulateTransaction|sendTransaction|isBlockhashValid|minimumLedgerSlot)$/;

type Call = { jsonrpc?: unknown; id?: unknown; method?: unknown };

const okCall = (c: unknown) => !!c && typeof c === "object" && typeof (c as Call).method === "string" && ALLOWED.test((c as Call).method as string);

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH || !calls.every(okCall)) {
    return Response.json({ error: "method not allowed" }, { status: 400 });
  }
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
