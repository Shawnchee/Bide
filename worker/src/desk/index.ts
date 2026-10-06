/** Agent desk public surface (A lane). See notes/desk.md for wiring. */
export * from "./types.js";
export { createDesk, createDeskFromEnv, provenance, type Desk, type DeskDeps, type RunOptions } from "./orchestrator.js";
export { readDeskConfig, describeDeskEnv, ZAI_DEFAULT_BASE_URL, type DeskConfig } from "./config.js";
export { DeskError, MissingSecretError, type DeskErrorCode } from "./errors.js";
export { canonicalJson, memoHash, sha256Bytes, normalizeForMemo } from "./canonical.js";
export { renderCard, type Card } from "./card.js";
export { TOOL_DEFS, TOOL_NAMES, Toolbox, distanceBand, roundKindOf } from "./tools.js";
export { quantProposalSchema, parseQuantProposal } from "./schema.js";
export { createZaiTransport, type ChatTransport, type ChatRequest, type ChatResponse } from "./llm/chat.js";
export { createRiskJudge, type RiskJudge } from "./risk/judge.js";
export { bindRisk, summariseRisk } from "./risk/binding.js";
export { RISK_QUESTIONS } from "./risk/questions.js";
export { CHAIN_ERROR_HINTS } from "./quant.js";
export { loadEventCalendar } from "./events.js";
