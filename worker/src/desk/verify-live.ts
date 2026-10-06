/**
 * Live VERIFY for the desk's external APIs (run once keys exist):
 *   pnpm --filter @bide/worker exec tsx src/desk/verify-live.ts
 * Checks (1) Z.ai chat completions + tool-call format with ZAI_MODEL_MAIN, (2) Clef REST answer
 * shapes. Prints env as NAME=SET/EMPTY only and never prints a key. Makes at most 3 small calls.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readDeskConfig, describeDeskEnv } from "./config.js";
import { createZaiTransport } from "./llm/chat.js";
import { callClefWorkersAi } from "./risk/clef.js";
import { callGlmRisk } from "./risk/glm.js";
import { bindRisk } from "./risk/binding.js";
import { errorMessage } from "./errors.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const cfg = readDeskConfig();
console.log("env:", describeDeskEnv());
console.log("zai base:", cfg.zai.baseUrl, "model:", cfg.zai.modelMain);

const sampleState = {
  asset: "SOL",
  round_type: "cash-secured put",
  user_stated_patience: "balanced",
  proposal: { strike_usd: "$110", size_human: "1.5 SOL", days_to_expiry: 17.7, premium_floor_usd: "$5.60", rationale: "Target 9% below spot; 2-4 week band; floor clears the minimum 1.2x." },
  market: { spot_usd: "$121", fill_probability: 0.31, venue_dispersion: { venues_used: 3, iv_spread_vol_pts: 1.8 } },
  events_before_expiry: [{ name: "US CPI (September 2026)", at_utc: "2026-10-14T12:30:00Z" }],
};

if (cfg.zai.apiKey) {
  const t = createZaiTransport({ apiKey: cfg.zai.apiKey, baseUrl: cfg.zai.baseUrl, timeoutMs: cfg.zai.timeoutMs });
  try {
    const r = await t.complete({
      model: cfg.zai.modelMain,
      messages: [{ role: "user", content: "What is the SOL spot price? Use the tool." }],
      tools: [{ type: "function", function: { name: "get_spot", description: "Spot price", parameters: { type: "object", properties: { asset: { type: "string" } }, required: ["asset"] } } }],
    });
    console.log("[zai tool-call] model:", r.model, "finish:", r.finish_reason, "tool_calls:", JSON.stringify(r.tool_calls), "has_reasoning:", !!r.reasoning_content);
  } catch (e) {
    console.log("[zai tool-call] FAILED:", errorMessage(e));
  }
  try {
    const g = await callGlmRisk({ transport: t, model: cfg.zai.modelRisk, state: sampleState });
    console.log("[glm risk] model:", g.model, "binding:", JSON.stringify(bindRisk(g.answers)));
  } catch (e) {
    console.log("[glm risk] FAILED:", errorMessage(e));
  }
} else console.log("[zai] skipped: ZAI_API_KEY EMPTY");

if (cfg.risk.cfAccountId && cfg.risk.cfToken) {
  try {
    const c = await callClefWorkersAi({ accountId: cfg.risk.cfAccountId, token: cfg.risk.cfToken, model: cfg.risk.clefModel, state: sampleState, timeoutMs: cfg.risk.timeoutMs });
    console.log("[clef] model:", c.model, "parsed:", JSON.stringify(c.answers));
    console.log("[clef] raw answers (check shapes vs risk/clef.ts ASSUMED notes):", JSON.stringify((c.raw as any)?.answers));
  } catch (e) {
    console.log("[clef] FAILED:", errorMessage(e), JSON.stringify((e as any)?.detail ?? {}).slice(0, 800));
  }
} else console.log("[clef] skipped: CF_ACCOUNT_ID / CF_AI_TOKEN EMPTY");
