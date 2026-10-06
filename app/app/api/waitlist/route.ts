import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Waitlist sign-up. Uses the anon key: the `waitlist` table must allow anon INSERT only
 * (no SELECT) via RLS — see notes/frontend.md.
 */
export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return Response.json({ error: "Sign-ups aren't open yet." }, { status: 503 });

  let body: { email?: unknown; price?: unknown; wallet?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const price = typeof body.price === "string" ? body.price.trim().slice(0, 80) : null;
  const wallet = typeof body.wallet === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.wallet) ? body.wallet : null;

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await sb.from("waitlist").insert({ email, target_note: price, wallet, source: "landing" });
  if (error) {
    if (error.code === "23505") return Response.json({ ok: true, duplicate: true });
    return Response.json({ error: "Couldn't save that right now. Try again in a minute." }, { status: 502 });
  }
  return Response.json({ ok: true });
}
