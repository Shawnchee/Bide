// Telegram notifications (BUILD §4.5). Disabled when TELEGRAM_BOT_TOKEN is EMPTY.
// /start <plan_pubkey> deep link → telegram_links(wallet = plan owner, chat_id, plan_pubkey).
import { cfg } from "../config.js";
import { logger } from "../log.js";
import type { Repo } from "../db/types.js";

const log = logger("notify");

export type NotifyEvent =
  | { type: "RoundTaken"; plan: string; owner: string; round: string; premiumUsdc: number; feeUsdc: number; isPool: boolean }
  | { type: "RoundResolved"; plan: string; owner: string; round: string; exercised: boolean; settlePriceUsd: number; strikeUsd: number }
  | { type: "PlanFlipped"; plan: string; owner: string }
  | { type: "PlanExpired"; plan: string; owner: string };

export function formatEvent(e: NotifyEvent, appUrl?: string): string {
  const link = appUrl ? `\n${appUrl}/plan/${e.plan}` : "";
  switch (e.type) {
    case "RoundTaken": return `💰 You got paid $${e.premiumUsdc.toFixed(4)} (after $${e.feeUsdc.toFixed(4)} fee) — ${e.isPool ? "backstop pool" : "a maker"} took your round.${link}`;
    case "RoundResolved": return e.exercised
      ? `✅ Filled at exactly $${e.strikeUsd.toFixed(2)} (settlement price $${e.settlePriceUsd.toFixed(2)}). You kept the premium.${link}`
      : `⏳ Not filled this round (settlement $${e.settlePriceUsd.toFixed(2)} vs your $${e.strikeUsd.toFixed(2)}). You kept the premium; your funds keep earning in Jupiter Lend.${link}`;
    case "PlanFlipped": return `🔁 Your buy side filled — the plan switched to selling at your exit price.${link}`;
    case "PlanExpired": return `🏁 Your plan reached its deadline; funds went back to your wallet.${link}`;
  }
}

/** Parse "/start <plan_pubkey>" (base58, 32–44 chars). */
export function parseStart(text: string | undefined): string | null {
  const m = /^\/start\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/.exec(text ?? "");
  return m ? m[1]! : null;
}

export class Notifier {
  readonly enabled = !!cfg.telegramBotToken;
  private offset = 0;
  constructor(private repo: Repo, private ownerOfPlan: (plan: string) => Promise<string | null>, private appUrl = process.env.APP_URL) {
    if (!this.enabled) log.info("telegram disabled (TELEGRAM_BOT_TOKEN EMPTY)");
  }
  private async api(method: string, body: unknown): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method} failed: ${j.description ?? res.status}`); // never include the URL (has the token)
    return j.result;
  }
  async notify(e: NotifyEvent) {
    if (!this.enabled) return;
    const chats = await this.repo.telegramChatsFor(e.owner);
    for (const chat_id of chats) await this.api("sendMessage", { chat_id, text: formatEvent(e, this.appUrl) }).catch((err) => log.warn("send failed", { err: err.message }));
  }
  /** One long-poll cycle of getUpdates; handles /start deep links. Call in a loop. */
  async pollOnce() {
    if (!this.enabled) return;
    const updates: any[] = await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] });
    for (const u of updates) {
      this.offset = u.update_id + 1;
      const chatId = u.message?.chat?.id;
      const plan = parseStart(u.message?.text);
      if (!chatId) continue;
      if (!plan) { await this.api("sendMessage", { chat_id: chatId, text: "Open your plan page on Bide and tap “Notify me on Telegram” to link it." }).catch(() => {}); continue; }
      const owner = await this.ownerOfPlan(plan);
      if (!owner) { await this.api("sendMessage", { chat_id: chatId, text: "I couldn't find that plan yet — try again in a minute." }).catch(() => {}); continue; }
      await this.repo.upsertTelegramLink({ wallet: owner, chat_id: chatId, plan_pubkey: plan });
      await this.api("sendMessage", { chat_id: chatId, text: "🔔 Linked. You'll get a message when your round is taken or settles." }).catch(() => {});
      log.info("telegram linked", { plan });
    }
  }
}
