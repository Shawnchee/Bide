// In-process Repo: used until SUPABASE_URL is set (same interface, no other code changes on switch).
import { randomUUID } from "node:crypto";
import type { DeskRunRow, EpochRow, IntakeRunRow, MakerBidRow, MakerStanceRow, PlanRow, QuoteRow, Repo, RoundRow, TelegramLinkRow } from "./types.js";

const MAX_QUOTES = 2000;
const now = () => new Date().toISOString();

export class MemoryRepo implements Repo {
  readonly backend = "memory" as const;
  quotes: QuoteRow[] = [];
  deskRuns = new Map<string, DeskRunRow>();
  plans = new Map<string, PlanRow>();
  rounds = new Map<string, RoundRow>();
  epochs = new Map<string, EpochRow>();
  links: TelegramLinkRow[] = [];
  ref = new Map<string, { value: unknown; updated_at: string }>();
  stances: MakerStanceRow[] = [];
  makerBids: MakerBidRow[] = [];
  intakes = new Map<string, IntakeRunRow>();

  async insertQuote(q: QuoteRow) { this.quotes.push({ ...q, ts: q.ts ?? now() }); if (this.quotes.length > MAX_QUOTES) this.quotes.splice(0, this.quotes.length - MAX_QUOTES); }
  async latestQuote(asset: string) { for (let i = this.quotes.length - 1; i >= 0; i--) if (this.quotes[i]!.asset === asset) return this.quotes[i]!; return null; }
  async createDeskRun(r: DeskRunRow) { const id = r.id ?? randomUUID(); this.deskRuns.set(id, { steps: [], status: "running", ...r, id, created_at: now(), updated_at: now() }); return id; }
  async updateDeskRun(id: string, patch: Partial<DeskRunRow>) { const r = this.deskRuns.get(id); if (r) this.deskRuns.set(id, { ...r, ...patch, updated_at: now() }); }
  async appendDeskStep(id: string, step: unknown) { const r = this.deskRuns.get(id); if (r) { r.steps = [...(r.steps ?? []), step]; r.updated_at = now(); } }
  async getDeskRun(id: string) { return this.deskRuns.get(id) ?? null; }
  async upsertPlans(rows: PlanRow[]) { for (const r of rows) this.plans.set(r.plan_pubkey, { ...r, updated_at: now() }); }
  async upsertRounds(rows: RoundRow[]) { for (const r of rows) this.rounds.set(r.round_pubkey, { ...r, sigs: { ...(this.rounds.get(r.round_pubkey)?.sigs ?? {}), ...(r.sigs ?? {}) }, updated_at: now() }); }
  async addRoundSig(round: string, label: string, sig: string) { const r = this.rounds.get(round); if (r) r.sigs = { ...(r.sigs ?? {}), [label]: sig }; }
  async upsertEpochs(rows: EpochRow[]) { for (const r of rows) this.epochs.set(r.epoch_pubkey, { ...r, updated_at: now() }); }
  async upsertTelegramLink(l: TelegramLinkRow) { if (!this.links.some((x) => x.wallet === l.wallet && x.chat_id === l.chat_id)) this.links.push(l); }
  async telegramChatsFor(wallet: string) { return this.links.filter((l) => l.wallet === wallet).map((l) => l.chat_id); }
  async getReference(key: string) { return this.ref.get(key) ?? null; }
  async setReference(key: string, value: unknown) { this.ref.set(key, { value, updated_at: now() }); }

  async insertMakerStance(r: MakerStanceRow) { const id = r.id ?? randomUUID(); this.stances.push({ ...r, id, created_at: r.created_at ?? now() }); return id; }
  async getMakerStance(stanceKey: string, maker: string) {
    for (let i = this.stances.length - 1; i >= 0; i--) { const s = this.stances[i]!; if (s.stance_key === stanceKey && s.maker === maker) return s; }
    return null;
  }
  async insertMakerBid(r: MakerBidRow) { const id = r.id ?? randomUUID(); this.makerBids.push({ ...r, id, created_at: r.created_at ?? now() }); return id; }
  async markMakerBidTook(round: string, maker: string, txSig: string) { for (const b of this.makerBids) if (b.round_pubkey === round && b.maker === maker) { b.took = true; b.tx_sig = txSig; } }
  async setMakerBidPnl(round: string, makerPubkey: string, pnl: string) { for (const b of this.makerBids) if (b.round_pubkey === round && b.maker_pubkey === makerPubkey && b.took) b.pnl_usdc = pnl; }
  async listMakerBids(q: { maker?: string; round?: string; took?: boolean; limit?: number }) {
    const out = this.makerBids.filter((b) => (!q.maker || b.maker === q.maker) && (!q.round || b.round_pubkey === q.round) && (q.took === undefined || b.took === q.took));
    return out.slice().reverse().slice(0, q.limit ?? 100);
  }
  async listRounds(q: { plan?: string; asset?: string; limit?: number }) {
    return [...this.rounds.values()]
      .filter((r) => (!q.plan || r.plan_pubkey === q.plan) && (!q.asset || r.asset === q.asset))
      .sort((a, b) => Date.parse(b.auction_start) - Date.parse(a.auction_start))
      .slice(0, q.limit ?? 50);
  }
  async createIntakeRun(r: IntakeRunRow) { const id = r.id ?? randomUUID(); this.intakes.set(id, { ...r, id, created_at: now(), updated_at: now() }); return id; }
  async updateIntakeRun(id: string, patch: Partial<IntakeRunRow>) { const r = this.intakes.get(id); if (r) this.intakes.set(id, { ...r, ...patch, updated_at: now() }); }
  async getIntakeRun(id: string) { return this.intakes.get(id) ?? null; }
}
