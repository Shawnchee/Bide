import { createActionHeaders, createPostResponse, type ActionGetResponse, type ActionPostRequest, type ActionPostResponse } from "@solana/actions";
import { Connection, PublicKey } from "@solana/web3.js";
import { ASSETS, PROGRAM_ID } from "@/lib/constants";
import { buildDraft, DAY, fmtPrice, MIN_PAY_PRESETS, type Goal } from "@/lib/plan-math";
import { buildCreatePlanTx, ProgramNotReadyError } from "@/lib/tx";
import { getBideClient } from "@/lib/bide-client";

// Solana Action (Blink) for a prefilled plan — BUILD §8 Phase 7 #3.
// GET  /api/actions/plan?side=buy&target=110&amount=20&days=30  → card
// POST same URL with { account }                                 → create_plan tx for that wallet

const headers = createActionHeaders({ chainId: "devnet", actionVersion: "2.4" });
const RPC = process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";

interface Params {
  goal: Goal;
  target: number;
  amount: number;
  days: number;
}

function parse(url: URL, override?: Partial<Record<string, string>>): Params | string {
  const g = (k: string) => override?.[k] ?? url.searchParams.get(k) ?? "";
  const goal = (g("side") || "buy").toLowerCase();
  if (goal !== "buy" && goal !== "sell") return "side must be buy or sell";
  const target = Number(g("target"));
  const amount = Number(g("amount"));
  const days = Number(g("days") || "30");
  if (!(target > 0)) return "target price is required";
  if (!(amount > 0)) return "amount is required";
  if (!(days >= 2 && days <= 180)) return "days must be between 2 and 180";
  return { goal, target, amount, days };
}

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const p = parse(url);
  const origin = url.origin;
  const base = `${origin}/api/actions/plan`;
  const title =
    typeof p === "string"
      ? "Name your price. Get paid until it fills."
      : p.goal === "buy"
        ? `Buy SOL at $${fmtPrice(p.target)} — get paid while you wait`
        : `Sell SOL at $${fmtPrice(p.target)} — get paid while you wait`;
  const body: ActionGetResponse = {
    type: "action",
    icon: `${origin}/api/actions/icon`,
    title,
    label: "Start earning",
    description:
      "Bide pays you upfront every round for the promise to buy (or sell) SOL at your price, checked once at each round's end — not on touch. Your funds earn Jupiter Lend interest meanwhile. Solana devnet, unaudited.",
    links: {
      actions:
        typeof p === "string"
          ? [
              {
                type: "transaction",
                label: "Start earning",
                href: `${base}?side={side}&target={target}&amount={amount}&days={days}`,
                parameters: [
                  { name: "side", label: "Buy or sell", type: "select", required: true, options: [{ label: "Buy cheaper", value: "buy" }, { label: "Sell higher", value: "sell" }] },
                  { name: "target", label: "Your price (USD)", type: "number", required: true },
                  { name: "amount", label: "Amount (USDC to buy with, or SOL to sell)", type: "number", required: true },
                  { name: "days", label: "Days to keep trying (2–180)", type: "number", required: true },
                ],
              },
            ]
          : [
              {
                type: "transaction",
                label: p.goal === "buy" ? `Commit ${p.amount} USDC` : `Commit ${p.amount} SOL`,
                href: `${base}?side=${p.goal}&target=${p.target}&amount=${p.amount}&days=${p.days}`,
              },
            ],
    },
  };
  return Response.json(body, { headers });
};

export const OPTIONS = GET;

export const POST = async (req: Request) => {
  const url = new URL(req.url);
  const p = parse(url);
  if (typeof p === "string") return Response.json({ message: p }, { status: 400, headers });
  let account: PublicKey;
  try {
    const body: ActionPostRequest = await req.json();
    account = new PublicKey(body.account);
  } catch {
    return Response.json({ message: "Invalid account" }, { status: 400, headers });
  }
  const now = Math.floor(Date.now() / 1000);
  const conn = new Connection(RPC, "confirmed");
  // Strike tick: on-chain Asset.strike_tick when it exists, else the default constant.
  let asset = ASSETS.SOL;
  try {
    const t = await getBideClient(conn)?.fetchStrikeTick(conn, asset.mint);
    if (t && t > 0n) asset = { ...asset, strikeTick: t };
  } catch {
    /* program/asset not live yet — default tick */
  }
  const draft = buildDraft({
    goal: p.goal,
    asset,
    quick: false,
    targetDollars: p.target,
    exitDollars: null,
    amount: p.amount,
    horizonEnd: now + p.days * DAY,
    minPayBps: MIN_PAY_PRESETS[1].bps,
    now,
  });
  if (draft.error) return Response.json({ message: draft.error }, { status: 400, headers });
  try {
    const prog = await conn.getAccountInfo(PROGRAM_ID);
    if (!prog?.executable) throw new ProgramNotReadyError();
    const tx = await buildCreatePlanTx(conn, account, asset, draft);
    const payload: ActionPostResponse = await createPostResponse({
      fields: {
        type: "transaction",
        transaction: tx,
        message: `Plan created: ${p.goal} SOL at $${p.target}. Track it on Bide.`,
      },
    });
    return Response.json(payload, { headers });
  } catch (e) {
    const msg = e instanceof ProgramNotReadyError ? e.message : "Couldn't build the transaction. Try again.";
    return Response.json({ message: msg }, { status: e instanceof ProgramNotReadyError ? 503 : 500, headers });
  }
};
