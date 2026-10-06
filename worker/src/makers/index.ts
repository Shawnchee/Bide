// Maker bots (BUILD §4.2 + docs/ai-agents.md): poll Auction rounds every 2 s. Each bot's bid per round comes from its
// AI stance for that epoch (bid = fair × (1 − spread_pct/100), clamped) or, as fallback, the deterministic strategy
// (own vol tilt + fresh random spread). Take when auction_price(now) ≤ bid. Every bid is stored in maker_bids.
import { PublicKey, type Keypair } from "@solana/web3.js";
import { blackPrice } from "../pricer/bs.js";
import type { BideChain } from "../chain/client.js";
import { parseProgramError } from "../chain/errors.js";
import type { SnapshotCache } from "../chain/snapshot-cache.js";
import type { AssetState, ChainSnapshot, RoundState } from "../chain/types.js";
import type { Repo } from "../db/types.js";
import type { MakerAgents, StanceEntry } from "../agents/maker/service.js";
import { bidFromStance, hashRecord } from "../agents/maker/stance.js";
import { logger } from "../log.js";
import type { Pricer } from "../pricer/index.js";
import { DEFAULT_PROFILES, drawSpread, makerBid, makerDecide, type Inventory, type MakerProfile } from "./strategy.js";

const log = logger("makers");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
/** Leave this much of max_spot_age_secs for the take tx to land. */
export const SPOT_AGE_MARGIN_SECS = 15;
/** Program errors on take_round that a later feed update can clear. */
const RETRY_PROGRAM_ERRORS = new Set(["StalePrice", "PriceConfidenceTooWide"]);

interface Bot { profile: MakerProfile; kp: Keypair; inv?: Inventory; invAt: number }
/** One bot's decided bid for one round (null bid = pass / no bid). Persisted to maker_bids. */
export interface BotBid {
  bid: bigint | null; source: "llm" | "fallback"; stance: "bid" | "pass"; stanceId: string | null; spreadPct: number | null;
  thesis: string | null; confidence: number | null; reason: string | null;
}
interface RoundView { priced: boolean; fair: bigint; fairIv: number; spot: number; fallbackBids: Map<string, { bid: bigint; spread: number }>; bids: Map<string, BotBid>; at: number }

export interface MakersOptions { repo?: Repo; agents?: MakerAgents | null }

/** Wait at most this long after auction start for a pending stance before falling back. */
export const STANCE_GRACE_SECS = 15;

/** Decide a bot's bid for a round from its stance (LLM) or the deterministic strategy (fallback). null = keep waiting. */
export function decideBotBid(a: {
  round: Pick<RoundState, "premiumStart" | "premiumFloor" | "auctionStart" | "auctionSecs">; nowSecs: number; fair: bigint;
  fallback: { bid: bigint; spread: number } | undefined; stance: StanceEntry | undefined; llmEnabled: boolean; volTilt: number;
}): BotBid | null {
  let reason: string;
  let stanceId: string | null = null;
  if (a.llmEnabled) {
    const e = a.stance;
    if (e?.status === "ready" && e.row.source === "llm" && e.row.stance) {
      const b = bidFromStance(e.row.stance, e.row.spread_pct ?? 0, a.fair, a.round.premiumFloor, a.round.premiumStart);
      return { bid: b.bid, source: "llm", stance: e.row.stance, stanceId: e.row.id, spreadPct: e.row.spread_pct, thesis: e.row.thesis, confidence: e.row.confidence, reason: b.note };
    }
    const grace = Math.min(STANCE_GRACE_SECS, Math.floor(a.round.auctionSecs / 2));
    if ((!e || e.status === "pending") && a.nowSecs < a.round.auctionStart + grace) return null;
    reason = !e ? "no stance for this epoch" : e.status === "pending" ? "stance still pending at round open" : e.row.fallback_reason ?? "stance unavailable";
    if (e?.status === "ready") stanceId = e.row.id;
  } else reason = "MAKER_LLM off";
  if (!a.fallback) return { bid: null, source: "fallback", stance: "pass", stanceId, spreadPct: null, thesis: null, confidence: null, reason: `${reason}; cannot price` };
  const pctOfFair = a.fair > 0n ? Math.round((1 - Number(a.fallback.bid) / Number(a.fair)) * 10_000) / 100 : null;
  const tilt = `${a.volTilt >= 0 ? "+" : "−"}${Math.abs(a.volTilt * 100)}%`;
  return {
    bid: a.fallback.bid, source: "fallback", stance: "bid", stanceId, spreadPct: pctOfFair, confidence: null, reason,
    thesis: `Deterministic fallback: fair at implied vol ${tilt}, minus a random ${(a.fallback.spread * 100).toFixed(1)}% spread.`,
  };
}

export class Makers {
  private bots: Bot[];
  private seen = new Map<string, RoundView>();
  private attempted = new Set<string>();
  private staleLogged = new Set<string>();
  /** Bid inserts in flight (a take must not mark `took` before its row exists). */
  private persisting = new Map<string, Promise<void>>();
  private repo?: Repo;
  private agents: MakerAgents | null;
  constructor(private chain: BideChain, private snapshots: SnapshotCache, private pricer: Pricer, keys: { name: string; kp: Keypair }[], private usdcMint: PublicKey, opts: MakersOptions = {}) {
    this.bots = keys.map((k, i) => ({ profile: { ...(DEFAULT_PROFILES[i] ?? DEFAULT_PROFILES[0]!), name: k.name }, kp: k.kp, invAt: 0 }));
    this.repo = opts.repo;
    this.agents = opts.agents ?? null;
    log.info("makers", { bots: this.bots.map((b) => ({ name: b.profile.name, pubkey: b.kp.publicKey.toBase58(), volTilt: b.profile.volTilt })), llm: !!this.agents });
  }
  setAgents(a: MakerAgents | null) { this.agents = a; }
  get botKeys() { return this.bots.map((b) => ({ name: b.profile.name, pubkey: b.kp.publicKey.toBase58() })); }

  /** Inventory view for the maker agents (their own book only). */
  async inventoryFor(name: string, s: ChainSnapshot, asset: AssetState) {
    const b = this.bots.find((x) => x.profile.name === name);
    if (!b) return null;
    const inv = await this.inventory(b, s, asset.symbol === "SOL" ? WSOL : new PublicKey(asset.mint));
    return { ...inv, maxOpenNotional: b.profile.maxOpenNotional };
  }

  private async inventory(b: Bot, s: ChainSnapshot, assetMint: PublicKey): Promise<Inventory> {
    if (!b.inv || Date.now() - b.invAt > 10_000) {
      const [usdc, asset] = await Promise.all([this.chain.tokenBalance(b.kp.publicKey, this.usdcMint), this.chain.tokenBalance(b.kp.publicKey, assetMint)]);
      b.inv = { usdc, asset, openNotional: 0n };
      b.invAt = Date.now();
    }
    const me = b.kp.publicKey.toBase58();
    const openNotional = s.rounds.filter((r) => r.status === "Live" && r.maker === me).reduce((a, r) => a + r.notional, 0n);
    return { ...b.inv, openNotional };
  }

  /** Price a round once (consensus fair + spot) and each bot's deterministic fallback bid (tilted vol, fresh spread). */
  private async view(r: RoundState, s: ChainSnapshot): Promise<RoundView | null> {
    const cached = this.seen.get(r.pubkey);
    if (cached) return cached.priced ? cached : null;
    const asset = s.assets.find((a) => a.pubkey === r.asset);
    const ep = s.epochs.find((e) => e.pubkey === r.epoch);
    if (!asset) return null;
    const type = r.kind === "Put" ? "put" : "call";
    const q = await this.pricer.quote(asset.symbol, type, Number(r.strike) / 1e6, r.expiry * 1000, Number(r.size) / 10 ** asset.decimals, ep?.kind === "Quick");
    if (!q.ok) { log.info("cannot price round, bots skip", { round: r.pubkey, reason: q.reason }); this.seen.set(r.pubkey, { priced: false, fair: 0n, fairIv: 0, spot: 0, fallbackBids: new Map(), bids: new Map(), at: Date.now() }); return null; }
    const T = Math.max(r.expiry - s.now, 1) / (365 * 86400);
    const sizeWhole = Number(r.size) / 10 ** asset.decimals;
    const fallbackBids = new Map<string, { bid: bigint; spread: number }>();
    for (const b of this.bots) {
      const fairTilted = blackPrice(type, q.spot, Number(r.strike) / 1e6, T, q.fairIv * (1 + b.profile.volTilt)) * sizeWhole * 1e6;
      const s_i = drawSpread();
      fallbackBids.set(b.profile.name, { bid: makerBid(fairTilted, s_i), spread: s_i });
    }
    const v: RoundView = { priced: true, fair: Number.isFinite(q.fairPremium) ? BigInt(Math.max(0, Math.round(q.fairPremium))) : 0n, fairIv: q.fairIv, spot: q.spot, fallbackBids, bids: new Map(), at: Date.now() };
    this.seen.set(r.pubkey, v);
    return v;
  }

  private bidFor(r: RoundState, s: ChainSnapshot, v: RoundView, b: Bot): BotBid | null {
    const name = b.profile.name;
    const have = v.bids.get(name);
    if (have) return have;
    const d = decideBotBid({
      round: r, nowSecs: Math.floor(Date.now() / 1000), fair: v.fair, fallback: v.fallbackBids.get(name),
      stance: this.agents ? this.agents.lookup(r, name, s) : undefined, llmEnabled: !!this.agents, volTilt: b.profile.volTilt,
    });
    if (!d) return null;
    v.bids.set(name, d);
    log.info("bid", { round: r.pubkey, bot: name, source: d.source, stance: d.stance, bid: d.bid?.toString() ?? null, spread_pct: d.spreadPct, fair: v.fair.toString(), floor: r.premiumFloor.toString(), start: r.premiumStart.toString(), reason: d.reason });
    this.persisting.set(`${r.pubkey}|${name}`, this.persistBid(r, b, v, d));
    return d;
  }

  private async persistBid(r: RoundState, b: Bot, v: RoundView, d: BotBid) {
    if (!this.repo) return;
    const rec = {
      round_pubkey: r.pubkey, plan_pubkey: r.plan, maker: b.profile.name, maker_pubkey: b.kp.publicKey.toBase58(), stance_id: d.stanceId, source: d.source,
      stance: d.stance, spread_pct: d.spreadPct, fair_at_bid: v.fair.toString(), bid: d.bid?.toString() ?? null, thesis: d.thesis, confidence: d.confidence,
      reason: d.reason, created_at: new Date().toISOString(),
    };
    try {
      await this.repo.insertMakerBid({ ...rec, bid_hash: hashRecord(rec), took: false, tx_sig: null, pnl_usdc: null });
    } catch (e) { log.warn("persist maker bid failed", { round: r.pubkey, bot: b.profile.name, err: (e as Error).message }); }
  }

  async tick(): Promise<void> {
    const s = await this.snapshots.get();
    if (!s) return;
    const auctions = s.rounds.filter((r) => r.status === "Auction");
    for (const [k, v] of this.seen) if (Date.now() - v.at > 3_600_000) { this.seen.delete(k); this.staleLogged.delete(k); for (const b of this.bots) this.persisting.delete(`${k}|${b.profile.name}`); }
    for (const r of auctions) {
      if (this.attempted.has(r.pubkey)) continue;
      const v = await this.view(r, s);
      if (!v) continue;
      const asset = s.assets.find((a) => a.pubkey === r.asset)!;
      // Highest bid first: with a falling price, the bot willing to pay more is the one the auction reaches first.
      const ranked = this.bots.map((b) => ({ b, d: this.bidFor(r, s, v, b) })).filter((x) => x.d && x.d.bid !== null)
        .sort((x, y) => (y.d!.bid! > x.d!.bid! ? 1 : y.d!.bid! < x.d!.bid! ? -1 : 0));
      for (const { b, d: bb } of ranked) {
        const bid = bb!.bid!;
        const inv = await this.inventory(b, s, asset.symbol === "SOL" ? WSOL : new PublicKey(asset.mint));
        const d = makerDecide(r, bid, inv, b.profile, Math.floor(Date.now() / 1000));
        if (d.act !== "take") continue;
        // take_round reads spot from the push feed (StalePrice if older than max_spot_age_secs). The sponsored devnet feed
        // sometimes skips ~5 min; every send lands on-chain (skipPreflight), so wait for a fresh update instead of
        // burning failed txs — the auction keeps falling meanwhile, which only helps the next bid.
        if (this.chain.spotAgeSecs) {
          const age = await this.chain.spotAgeSecs(new PublicKey(r.asset)).catch(() => 0);
          if (age > asset.maxSpotAgeSecs - SPOT_AGE_MARGIN_SECS) {
            if (!this.staleLogged.has(r.pubkey)) { log.info("push feed stale, holding take", { round: r.pubkey, ageSecs: age, max: asset.maxSpotAgeSecs }); this.staleLogged.add(r.pubkey); }
            break;
          }
        }
        this.attempted.add(r.pubkey); // first bot to reach its bid sends; others stand down this round
        try {
          const sig = await this.chain.takeRound(b.kp, new PublicKey(r.pubkey));
          log.info("take_round", { round: r.pubkey, bot: b.profile.name, source: bb!.source, price: d.price.toString(), bid: d.bid.toString(), sig });
          await this.persisting.get(`${r.pubkey}|${b.profile.name}`);
          if (this.repo) await this.repo.markMakerBidTook(r.pubkey, b.profile.name, sig).catch((e) => log.warn("mark took failed", { err: (e as Error).message }));
          b.invAt = 0;
          this.snapshots.invalidate();
        } catch (e) {
          const pe = parseProgramError(e);
          log.warn("take_round failed", { round: r.pubkey, bot: b.profile.name, err: pe.name, msg: pe.message.slice(0, 200) });
          // StalePrice / PriceConfidenceTooWide can clear on the next feed update: retry this round, not give up.
          if (pe.retryable || (pe.name && RETRY_PROGRAM_ERRORS.has(pe.name))) this.attempted.delete(r.pubkey);
        }
        break;
      }
    }
  }
}
