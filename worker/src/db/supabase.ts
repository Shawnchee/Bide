import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DeskRunRow, EpochRow, IntakeRunRow, MakerBidRow, MakerStanceRow, PlanRow, QuoteRow, Repo, RoundRow } from "./types.js";

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

export class SupabaseRepo implements Repo {
  readonly backend = "supabase" as const;
  private db: SupabaseClient;
  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  /** null if the table is readable, else the error message (e.g. PGRST205 "Could not find the table"). 8 s cap. */
  async probeTable(table: string): Promise<string | null> {
    const res = await Promise.race([
      // Not a HEAD request: on a missing table PostgREST's 404 has no body under HEAD and supabase-js reports no error.
      this.db.from(table).select("*").limit(1),
      new Promise<{ error: { message: string }; status: number }>((r) => setTimeout(() => r({ error: { message: "probe timeout" }, status: 0 }), 8_000)),
    ]);
    if (res.error) return res.error.message || `HTTP ${res.status}`;
    return res.status >= 400 ? `HTTP ${res.status}` : null;
  }
  async insertQuote(q: QuoteRow) { check(await this.db.from("quotes").insert(q), "insert quote"); }
  async latestQuote(asset: string) {
    return check(await this.db.from("quotes").select("*").eq("asset", asset).order("ts", { ascending: false }).limit(1).maybeSingle(), "latest quote") as QuoteRow | null;
  }
  async createDeskRun(r: DeskRunRow) {
    const d = check(await this.db.from("desk_runs").insert(r).select("id").single(), "create desk run") as { id: string };
    return d.id;
  }
  async updateDeskRun(id: string, patch: Partial<DeskRunRow>) {
    check(await this.db.from("desk_runs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id), "update desk run");
  }
  async appendDeskStep(id: string, step: unknown) {
    // Read-modify-write is fine: one desk run is written by one worker task at a time.
    const cur = check(await this.db.from("desk_runs").select("steps").eq("id", id).single(), "read steps") as { steps: unknown[] };
    await this.updateDeskRun(id, { steps: [...(cur.steps ?? []), step] });
  }
  async getDeskRun(id: string) { return check(await this.db.from("desk_runs").select("*").eq("id", id).maybeSingle(), "get desk run") as DeskRunRow | null; }
  async upsertPlans(rows: PlanRow[]) { if (rows.length) check(await this.db.from("plans").upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))), "upsert plans"); }
  async upsertRounds(rows: RoundRow[]) {
    if (!rows.length) return;
    // Don't clobber sigs: write rows without sigs, merge sigs separately.
    check(await this.db.from("rounds").upsert(rows.map(({ sigs: _s, ...r }) => ({ ...r, updated_at: new Date().toISOString() }))), "upsert rounds");
    for (const r of rows) for (const [k, v] of Object.entries(r.sigs ?? {})) await this.addRoundSig(r.round_pubkey, k, v);
  }
  async addRoundSig(round: string, label: string, sig: string) {
    const cur = check(await this.db.from("rounds").select("sigs").eq("round_pubkey", round).maybeSingle(), "read sigs") as { sigs: Record<string, string> } | null;
    if (!cur) return;
    check(await this.db.from("rounds").update({ sigs: { ...(cur.sigs ?? {}), [label]: sig } }).eq("round_pubkey", round), "add sig");
  }
  async upsertEpochs(rows: EpochRow[]) { if (rows.length) check(await this.db.from("epochs").upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))), "upsert epochs"); }
  async getReference(key: string) { return check(await this.db.from("reference_data").select("value, updated_at").eq("key", key).maybeSingle(), "get ref") as any; }
  async setReference(key: string, value: unknown) { check(await this.db.from("reference_data").upsert({ key, value, updated_at: new Date().toISOString() }), "set ref"); }

  async insertMakerStance(r: MakerStanceRow) { return (check(await this.db.from("maker_stances").insert(r).select("id").single(), "insert maker stance") as { id: string }).id; }
  async getMakerStance(stanceKey: string, maker: string) {
    return check(await this.db.from("maker_stances").select("*").eq("stance_key", stanceKey).eq("maker", maker).order("created_at", { ascending: false }).limit(1).maybeSingle(), "get maker stance") as MakerStanceRow | null;
  }
  async insertMakerBid(r: MakerBidRow) { return (check(await this.db.from("maker_bids").insert(r).select("id").single(), "insert maker bid") as { id: string }).id; }
  async markMakerBidTook(round: string, maker: string, txSig: string) {
    check(await this.db.from("maker_bids").update({ took: true, tx_sig: txSig }).eq("round_pubkey", round).eq("maker", maker), "mark maker bid took");
  }
  async setMakerBidPnl(round: string, makerPubkey: string, pnl: string) {
    check(await this.db.from("maker_bids").update({ pnl_usdc: pnl }).eq("round_pubkey", round).eq("maker_pubkey", makerPubkey).eq("took", true), "set maker pnl");
  }
  async listMakerBids(q: { maker?: string; round?: string; took?: boolean; limit?: number }) {
    let req = this.db.from("maker_bids").select("*");
    if (q.maker) req = req.eq("maker", q.maker);
    if (q.round) req = req.eq("round_pubkey", q.round);
    if (q.took !== undefined) req = req.eq("took", q.took);
    return check(await req.order("created_at", { ascending: false }).limit(q.limit ?? 100), "list maker bids") as MakerBidRow[];
  }
  async listRounds(q: { plan?: string; asset?: string; limit?: number }) {
    let req = this.db.from("rounds").select("*");
    if (q.plan) req = req.eq("plan_pubkey", q.plan);
    if (q.asset) req = req.eq("asset", q.asset);
    return check(await req.order("auction_start", { ascending: false }).limit(q.limit ?? 50), "list rounds") as RoundRow[];
  }
  async createIntakeRun(r: IntakeRunRow) { return (check(await this.db.from("intake_runs").insert(r).select("id").single(), "create intake run") as { id: string }).id; }
  async updateIntakeRun(id: string, patch: Partial<IntakeRunRow>) {
    check(await this.db.from("intake_runs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id), "update intake run");
  }
  async getIntakeRun(id: string) { return check(await this.db.from("intake_runs").select("*").eq("id", id).maybeSingle(), "get intake run") as IntakeRunRow | null; }
}
