/**
 * Minimal OpenAI-compatible Chat Completions types + the Z.ai transport (plain fetch, no SDK).
 * Z.ai facts (docs.z.ai, checked 2026-10-05): POST {base}/chat/completions, Bearer auth,
 * OpenAI-style `tools` / `tool_calls` (arguments = JSON string), `tool_choice` accepts only
 * "auto", `response_format` supports {type:"json_object"} (no json_schema), GLM-5.3 always
 * thinks (reasoning in `message.reasoning_content`).
 */
import { DeskError, MissingSecretError } from "../errors.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  response_format?: { type: "json_object" | "text" };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  model: string;
  content: string | null;
  tool_calls: ToolCall[];
  reasoning_content: string | null;
  finish_reason: string | null;
  usage?: Record<string, unknown>;
}

/** The only seam to the model. Product code uses `createZaiTransport`; tests inject a test double. */
export interface ChatTransport {
  readonly provider: string;
  complete(req: ChatRequest): Promise<ChatResponse>;
}

export interface ZaiOptions {
  apiKey: string | undefined;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createZaiTransport(opts: ZaiOptions): ChatTransport {
  const f = opts.fetchImpl ?? fetch;
  return {
    provider: "z.ai",
    async complete(req) {
      if (!opts.apiKey) throw new MissingSecretError("ZAI_API_KEY", "the GLM Quant / GLM risk fallback");
      const body: Record<string, unknown> = { ...req, stream: false };
      if (req.tools?.length) body.tool_choice = "auto";
      let res: Response;
      try {
        res = await f(`${opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (e) {
        throw new DeskError("MODEL_HTTP", `Z.ai request failed: ${(e as Error).message}`);
      }
      const text = await res.text();
      if (!res.ok) throw new DeskError("MODEL_HTTP", `Z.ai HTTP ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
      return parseChatCompletion(text);
    },
  };
}

/** Parse an OpenAI-shaped chat.completion body. Exported for tests with recorded fixtures. */
export function parseChatCompletion(text: string): ChatResponse {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new DeskError("MODEL_RESPONSE", `non-JSON body: ${text.slice(0, 200)}`);
  }
  const choice = j?.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new DeskError("MODEL_RESPONSE", `no choices[0].message in body: ${text.slice(0, 300)}`);
  const tool_calls: ToolCall[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((t: any, i: number) => ({
        id: String(t.id ?? `call_${i}`),
        type: "function" as const,
        function: {
          name: String(t.function?.name ?? ""),
          arguments: typeof t.function?.arguments === "string" ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {}),
        },
      }))
    : [];
  return {
    model: String(j.model ?? ""),
    content: typeof msg.content === "string" ? msg.content : null,
    tool_calls,
    reasoning_content: typeof msg.reasoning_content === "string" ? msg.reasoning_content : null,
    finish_reason: choice.finish_reason ?? null,
    usage: j.usage,
  };
}
