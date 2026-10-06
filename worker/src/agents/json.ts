/** Single-shot JSON calls to GLM with zod validation and one repair turn (same policy as the desk Quant). */
import type { z } from "zod";
import type { ChatMessage, ChatTransport } from "../desk/llm/chat.js";

/** Pull the first JSON object out of a reply (tolerates ```json fences and leading prose). */
export function extractJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("no JSON object in reply");
}

export function zodIssues(e: z.ZodError): string {
  return e.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export interface JsonCallResult<T> { value: T; model: string; repaired: boolean; raw: string }

export class AgentOutputError extends Error {
  constructor(message: string, readonly raw: string) { super(message); this.name = "AgentOutputError"; }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

export async function completeJson<S extends z.ZodTypeAny>(o: {
  transport: ChatTransport; model: string; system: string; user: string; schema: S; temperature?: number;
}): Promise<JsonCallResult<z.infer<S>>> {
  const msgs: ChatMessage[] = [{ role: "system", content: o.system }, { role: "user", content: o.user }];
  const attempt = (text: string): { ok: true; v: z.infer<S> } | { ok: false; err: string } => {
    let obj: unknown;
    try { obj = extractJsonObject(text); } catch (e) { return { ok: false, err: (e as Error).message }; }
    const r = o.schema.safeParse(obj);
    return r.success ? { ok: true, v: r.data } : { ok: false, err: zodIssues(r.error) };
  };
  const r1 = await o.transport.complete({ model: o.model, messages: msgs, temperature: o.temperature ?? 0.3 });
  const t1 = r1.content ?? "";
  const a1 = attempt(t1);
  if (a1.ok) return { value: a1.v, model: r1.model || o.model, repaired: false, raw: t1 };
  msgs.push({ role: "assistant", content: t1 }, { role: "user", content: `Your reply did not match the required JSON: ${a1.err}. Reply with ONLY the corrected JSON object.` });
  const r2 = await o.transport.complete({ model: o.model, messages: msgs, temperature: 0 });
  const t2 = r2.content ?? "";
  const a2 = attempt(t2);
  if (a2.ok) return { value: a2.v, model: r2.model || o.model, repaired: true, raw: t2 };
  throw new AgentOutputError(`output invalid after one repair: ${a2.err}`, t2.slice(0, 500));
}
