import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Minus, X } from "lucide-react";
import { LiveExample } from "@/components/landing/live-example";

const STEPS = [
  { title: "Name a price", body: "“Buy SOL at $110 by Nov 5.” One signature." },
  { title: "Get paid every round", body: "Traders bid for your order. You keep the pay, filled or not." },
  { title: "Fills at your price", body: "Checked once at round end, not when the price touches." },
];

type Cell = { v: "yes" | "no" | "partly" | "text"; t: string };
const y = (t = "Yes"): Cell => ({ v: "yes", t });
const n = (t = "No"): Cell => ({ v: "no", t });
const p = (t: string): Cell => ({ v: "partly", t });
const tx = (t: string): Cell => ({ v: "text", t });

const ALL_COLS = ["Jupiter Trigger", "Jupiter Earn on Recurring", "Meteora DLMM limit", "Leaps Finance", "Bide"];
/** The one comparison row shown inline: limit orders vs the closest rival vs Bide. */
const QUICK = [0, 2, 3, 4];
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
      <section className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-12 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:items-center lg:pt-20 lg:pb-16">
        <div>
          <h1 className="font-display text-[40px] leading-[1.02] tracking-[-0.035em] text-balance sm:text-6xl lg:text-[64px]">
            Name your price. Get paid until it fills.
          </h1>
          <p className="mt-5 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
            A limit order that pays you while it waits.
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

      <section aria-label="How it works" className="border-y border-border bg-card">
        <ol className="mx-auto grid max-w-6xl gap-px px-4 py-8 sm:grid-cols-3 sm:gap-6 sm:px-6">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-3 py-3">
              <span className="num grid size-7 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{i + 1}</span>
              <div>
                <h2 className="text-base font-semibold tracking-tight">{s.title}</h2>
                <p className="mt-1 text-sm text-pretty text-muted-foreground">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="vs-h" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 id="vs-h" className="text-sm font-semibold">
          Paid upfront, filled or not
        </h2>
        <ul className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-4">
          {QUICK.map((i) => (
            <li key={ALL_COLS[i]} className={ALL_COLS[i] === "Bide" ? "bg-accent/40 p-4" : "bg-card p-4"}>
              <p className={ALL_COLS[i] === "Bide" ? "text-xs font-semibold text-primary" : "text-xs text-muted-foreground"}>{ALL_COLS[i]}</p>
              <p className="mt-1.5 text-sm">
                <CellView c={ROWS[0].cells[i]} />
              </p>
            </li>
          ))}
        </ul>

        <details className="group mt-6 rounded-2xl border border-border bg-card">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-5 [&::-webkit-details-marker]:hidden">
            How it works
            <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
          </summary>
          <div className="grid gap-6 border-t border-border px-4 py-5 sm:px-5">
            <ul className="grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
              <li>
                <span className="font-medium text-foreground">Your limits live on-chain.</span> The program rejects anything outside them.
              </li>
              <li>
                <span className="font-medium text-foreground">Priced from real exchanges.</span> Deribit, OKX, Bybit and Binance quotes.
              </li>
              <li>
                <span className="font-medium text-foreground">Nothing gets stuck.</span> Anyone can settle or unwind a round.
              </li>
            </ul>
            <div className="overflow-x-auto rounded-xl border border-border bg-background">
              <table className="data-table min-w-[56rem]">
                <thead>
                  <tr>
                    <th scope="col" className="w-56">
                      <span className="sr-only">Feature</span>
                    </th>
                    {ALL_COLS.map((c) => (
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
            <p className="text-xs text-muted-foreground">As of Oct 2026, from each product&apos;s public docs.</p>
          </div>
        </details>
      </section>
    </>
  );
}
