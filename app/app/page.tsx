import Link from "next/link";
import { ArrowRight, Check, Minus, X } from "lucide-react";
import { LiveExample } from "@/components/landing/live-example";
import { Waitlist } from "@/components/landing/waitlist";

const STEPS = [
  {
    title: "Name a price and a deadline",
    body: "“Buy SOL at $110 by Nov 5” or “Sell my SOL at $150.” Pick an amount. One signature.",
  },
  {
    title: "Get paid upfront, every round",
    body: "Traders bid in a public auction for the right to fill you at your price. You keep what they pay, filled or not. Meanwhile your funds earn Jupiter Lend interest.",
  },
  {
    title: "It fills at exactly your price — or you keep your funds",
    body: "At the end of each round the price is checked once, using Pyth. Below your buy price, you buy at exactly your price. Otherwise the next round starts.",
  },
];

type Cell = { v: "yes" | "no" | "partly" | "text"; t: string };
const y = (t = "Yes"): Cell => ({ v: "yes", t });
const n = (t = "No"): Cell => ({ v: "no", t });
const p = (t: string): Cell => ({ v: "partly", t });
const tx = (t: string): Cell => ({ v: "text", t });

const COLS = ["Jupiter Trigger", "Jupiter Earn on Recurring", "Meteora DLMM limit", "Leaps Finance", "Bide"];
const ROWS: { label: string; cells: Cell[] }[] = [
  { label: "Paid upfront, filled or not", cells: [n(), n(), n(), y(), y("Yes, every round")] },
  { label: "Earns while waiting", cells: [n(), y("Lend yield"), p("Swap fees, if volume crosses your bins"), n(), y("Lend yield on the collateral")] },
  { label: "When it fills", cells: [tx("On touch"), tx("DCA schedule"), tx("On touch"), tx("At expiry"), tx("At expiry, at exactly your price")] },
  { label: "Works for “buy at my price”", cells: [y(), n("DCA only"), y(), p("Manual options"), y()] },
  { label: "Multi-round goals, run for you", cells: [n(), n(), n(), n("Manual re-open"), y()] },
  { label: "Change the plan between rounds", cells: [y("Cancel"), y(), y(), n("Locked to expiry"), y()] },
  { label: "AI with on-chain guardrails", cells: [n(), n(), n(), n(), y()] },
  { label: "Who can take the other side", cells: [tx("—"), tx("—"), tx("—"), tx("Whitelisted pro makers"), tx("Any wallet; anyone can LP")] },
  { label: "Status today", cells: [tx("Mainnet"), tx("Mainnet"), tx("Mainnet"), tx("Mainnet, audited"), tx("Devnet, unaudited")] },
];

function CellView({ c }: { c: Cell }) {
  if (c.v === "text") return <span>{c.t}</span>;
  const Icon = c.v === "yes" ? Check : c.v === "no" ? X : Minus;
  return (
    <span className="inline-flex items-start gap-1.5">
      <Icon className={c.v === "yes" ? "mt-0.5 size-4 shrink-0 text-primary" : "mt-0.5 size-4 shrink-0 text-muted-foreground"} aria-hidden />
      <span className={c.v === "yes" ? "" : "text-muted-foreground"}>{c.t}</span>
    </span>
  );
}

export default function Home() {
  return (
    <>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:items-center lg:pt-20 lg:pb-24">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden /> For SOL holders and USDC savers
          </p>
          <h1 className="mt-5 font-display text-[40px] leading-[1.02] tracking-[-0.035em] text-balance sm:text-6xl lg:text-[64px]">
            Name your price. Get paid until it fills.
          </h1>
          <p className="mt-5 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
            A limit order earns nothing while it waits. Bide pays you upfront every round for the promise to buy or sell at your price — and
            your funds earn Jupiter Lend interest the whole time.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/earn"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-primary px-6 font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none active:translate-y-px"
            >
              Start a plan <ArrowRight className="size-4" aria-hidden />
            </Link>
            <Link
              href="/desk"
              className="inline-flex h-12 items-center rounded-xl bg-secondary px-6 font-medium transition-colors duration-150 hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Watch the AI desk
            </Link>
          </div>
        </div>
        <LiveExample />
      </section>

      <section aria-labelledby="how-h" className="border-y border-border bg-card">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-16 lg:grid-cols-[1fr_2fr]">
          <div>
            <h2 id="how-h" className="font-display text-3xl leading-tight sm:text-4xl">
              How it works
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Checked once at the end of each round — not the moment the price touches your level. Same price as a limit order, different
              trigger.
            </p>
          </div>
          <ol className="grid gap-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-3 rounded-2xl bg-secondary/60 p-4 sm:p-5">
                <span className="num grid size-7 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{i + 1}</span>
                <div>
                  <h3 className="text-base font-semibold tracking-tight">{s.title}</h3>
                  <p className="mt-1 text-sm text-pretty text-muted-foreground">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="trust-h" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 id="trust-h" className="max-w-3xl font-display text-3xl leading-tight text-balance sm:text-4xl">
          The AI is allowed to try. The Solana program decides.
        </h2>
        <div className="mt-8 grid gap-3 md:grid-cols-3 [&>div]:rounded-2xl [&>div]:border [&>div]:border-border [&>div]:bg-card [&>div]:p-5">
          <div>
            <h3 className="font-medium">Your limits live on-chain</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Price, deadline and minimum pay are stored in your plan. Anything outside them is rejected by the program — and those rejections
              are public on the desk page.
            </p>
          </div>
          <div>
            <h3 className="font-medium">Priced from real exchanges</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Each auction is anchored to live option quotes from Deribit, OKX, Bybit and Binance. The floor sits near the best exchange bid, so
              you&apos;re never filled far below the market.
            </p>
          </div>
          <div>
            <h3 className="font-medium">Nothing gets stuck</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              If our servers go down, anyone can settle or unwind a round. Every desk decision is hashed and the hash is stored on-chain.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="vs-h" className="border-t border-border bg-card">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
          <h2 id="vs-h" className="font-display text-3xl leading-tight sm:text-4xl">
            How Bide compares
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Honest version. Leaps already sells the same core instrument on mainnet with pro makers; Bide wraps it in a goal, adds Lend yield,
            and lets anyone take the other side.
          </p>
          <div className="mt-8 overflow-x-auto rounded-2xl border border-border bg-background">
            <table className="data-table min-w-[56rem]">
              <thead>
                <tr>
                  <th scope="col" className="w-56">
                    <span className="sr-only">Feature</span>
                  </th>
                  {COLS.map((c) => (
                    <th key={c} scope="col" className={c === "Bide" ? "text-primary!" : undefined}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.label} className="align-top">
                    <th scope="row" className="font-medium">
                      {r.label}
                    </th>
                    {r.cells.map((c, i) => (
                      <td key={i} className={i === r.cells.length - 1 ? "bg-accent/40" : undefined}>
                        <CellView c={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Comparison as of Oct 2026, from each product&apos;s public docs.</p>
        </div>
      </section>

      <section aria-labelledby="wl-h" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr] lg:items-end">
          <div>
            <h2 id="wl-h" className="font-display text-3xl leading-tight sm:text-4xl">
              Want it on mainnet?
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">Bide runs on Solana devnet today. Leave your email and the price you&apos;d name.</p>
          </div>
          <Waitlist />
        </div>
      </section>
    </>
  );
}
