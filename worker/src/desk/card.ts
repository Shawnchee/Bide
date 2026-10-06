/**
 * Plain-English card (SPEC §5 step 6). Deterministic code, no model. No options jargon in the
 * template text (no "put", "call", "strike", "premium", "option", "expiry", "exercise").
 * The Quant's rationale is passed through separately as `desk_note`, not mixed into the lines.
 */
import type { DeskFinal, PlanView, ToolTrace } from "./types.js";
import { roundKindOf } from "./tools.js";
import { afterFee, formatUnits, notional, usd, usdPrice } from "./units.js";

export interface Card {
  kind: "open" | "skip" | "vetoed" | "flip" | "stop" | "error";
  headline: string;
  lines: string[];
  warning: string | null;
  footnote: string | null;
  desk_note: string | null;
  text: string;
  numbers: Record<string, string | null>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(unix: number): string {
  const d = new Date(unix * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** strike × pct/100, snapped to whole dollars (bigint, USDC base units). */
function scaled(strike: bigint, pct: bigint): bigint {
  return ((strike * pct) / 100n / 1_000_000n) * 1_000_000n;
}

/** Estimated Lend interest (USDC base units) on `principal` over `secs` at `apyBps`. Display only. */
export function lendInterest(principal: bigint, apyBps: number, secs: number): bigint {
  if (apyBps <= 0 || secs <= 0) return 0n;
  return (principal * BigInt(Math.round(apyBps)) * BigInt(Math.floor(secs))) / (10_000n * 365n * 86_400n);
}

function latestApy(traces: ToolTrace[]): { bps: number; label: string } | null {
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i]!;
    if (t.name !== "lend_apy" || !t.ok) continue;
    const r = t.result as any;
    if (typeof r?.devnet_apy_bps === "number") return { bps: r.devnet_apy_bps, label: "" };
    if (typeof r?.mainnet_reference_apy_bps === "number") return { bps: r.mainnet_reference_apy_bps, label: " (at Jupiter's mainnet reference rate)" };
  }
  return null;
}

function compose(c: Omit<Card, "text">): Card {
  const text = [c.headline, ...c.lines, c.warning ? `⚠️ ${c.warning}` : null, c.footnote].filter(Boolean).join("\n");
  return { ...c, text };
}

export function renderCard(args: { final: DeskFinal; plan: PlanView | null; traces: ToolTrace[]; now_ms: number }): Card {
  const { final, plan } = args;
  const p = final.proposal;
  const note = p?.rationale ?? null;

  if (final.status === "error" || !plan) {
    return compose({ kind: "error", headline: "No new round this time.", lines: ["The desk could not finish its check, so nothing was opened. Your funds stay where they are and keep earning in Jupiter Lend."], warning: null, footnote: null, desk_note: null, numbers: {} });
  }
  const asset = plan.asset;
  const kind = roundKindOf(plan);
  const holding = kind === "put" ? "USDC" : asset;

  if (final.status === "vetoed") {
    return compose({ kind: "vetoed", headline: "Paused for this cycle.", lines: [`The risk check said no to this round. Your ${holding} keeps earning in Jupiter Lend, and the desk tries again next cycle.`], warning: null, footnote: null, desk_note: note, numbers: {} });
  }
  if (final.status === "skip") {
    return compose({ kind: "skip", headline: "Waiting this cycle.", lines: [`The desk chose not to start a round right now. Your ${holding} keeps earning in Jupiter Lend, and the desk looks again next cycle.`], warning: null, footnote: null, desk_note: note, numbers: {} });
  }
  if (final.status === "flip") {
    return compose({ kind: "flip", headline: "Buy goal reached.", lines: [`You bought everything you asked for. Next, we try to sell your ${asset} at ${usdPrice(plan.exit_strike)} or higher, and you get paid while you wait.`], warning: null, footnote: null, desk_note: note, numbers: { exit_price: plan.exit_strike } });
  }
  if (final.status === "stop" || !p || p.action !== "open") {
    return compose({ kind: "stop", headline: "Goal complete.", lines: ["Nothing more to do on this plan."], warning: null, footnote: null, desk_note: note, numbers: {} });
  }

  // ---- open ----
  const strike = BigInt(p.strike!);
  const size = BigInt(p.size!);
  const expiry = p.expiry!;
  const n = notional(strike, size, plan.asset_decimals, kind === "put" ? "up" : "down");
  const lo = afterFee(p.premium_floor!, plan.fee_bps);
  const hi = afterFee(p.premium_start!, plan.fee_bps);
  const amt = `${formatUnits(size, plan.asset_decimals, 4)} ${asset}`;
  const usdc = `${formatUnits(n, 6, 2)} USDC`;
  const price = usdPrice(strike);
  const when = `${fmtDate(expiry)} at ${fmtTime(expiry)}`;
  const feePct = `${plan.fee_bps / 100}%`;
  const apy = latestApy(args.traces);
  const secs = expiry - Math.floor(args.now_ms / 1000);
  const interest = apy && kind === "put" ? lendInterest(n, apy.bps, secs) : null;

  const pay = lo === hi ? `You get ${usd(lo)} now` : `You get between ${usd(lo)} and ${usd(hi)} now`;
  const lines: string[] = [`${pay} (after our ${feePct} fee). Makers bid for it in a short auction; the earlier one takes it, the more you get.`];
  let warning: string;
  if (kind === "put") {
    lines.push(`On ${when}, if ${asset} is below ${price}, you buy ${amt} at ${price} (${usdc}).`);
    lines.push(
      `If not, your ${usdc} stays yours, you keep what you were paid` +
        (interest !== null && interest > 0n ? `, and it earns about ${usd(interest)} in Jupiter Lend interest meanwhile${apy!.label}.` : `, and it keeps earning in Jupiter Lend.`),
    );
    const dip = scaled(strike, 95n), back = scaled(strike, 105n), crash = scaled(strike, 75n);
    warning = `Checked once, on ${when}, not the moment the price touches ${price}. If ${asset} dips to ${usdPrice(dip)} before then and is back at ${usdPrice(back)} on ${fmtDate(expiry)}, you don't buy (you keep what you were paid). If ${asset} crashes to ${usdPrice(crash)}, you still buy at ${price}.`;
  } else {
    lines.push(`On ${when}, if ${asset} is above ${price}, you sell ${amt} at ${price} (you get ${usdc}).`);
    lines.push(`If not, you keep your ${amt} and what you were paid, and it keeps earning in Jupiter Lend.`);
    const spike = scaled(strike, 105n), back = scaled(strike, 95n), rally = scaled(strike, 125n);
    warning = `Checked once, on ${when}, not the moment the price touches ${price}. If ${asset} jumps to ${usdPrice(spike)} before then and is back at ${usdPrice(back)} on ${fmtDate(expiry)}, you don't sell (you keep what you were paid). If ${asset} rallies to ${usdPrice(rally)}, you still sell at ${price}.`;
  }
  lines.push("Then we set up the next round automatically (you can stop anytime between rounds).");

  return compose({
    kind: "open",
    headline: lo === hi ? `You get ${usd(lo)} now.` : `You get ${usd(lo)}–${usd(hi)} now.`,
    lines,
    warning,
    footnote: "Same price as a limit order, different trigger.",
    desk_note: note,
    numbers: {
      pay_after_fee_min: lo.toString(),
      pay_after_fee_max: hi.toString(),
      price: strike.toString(),
      size: size.toString(),
      amount_usdc: n.toString(),
      check_time: String(expiry),
      lend_interest_estimate: interest !== null ? interest.toString() : null,
    },
  });
}
