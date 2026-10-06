"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Mirrors worker/src/agents/intake.ts IntakeFields. Every field may be null (the assistant left it for you). */
export interface IntakeFields {
  goal: "buy" | "sell" | "both" | null;
  asset: "SOL" | null;
  quick: boolean | null;
  target_price_usd: number | null;
  exit_price_usd: number | null;
  amount: number | null;
  amount_unit: "USDC" | "SOL" | null;
  horizon: "1w" | "1m" | "3m" | "date" | "q30m" | "q1h" | "q3h" | null;
  deadline_date: string | null;
  min_pay: "relaxed" | "standard" | "choosy" | null;
  patience: "patient" | "balanced" | "eager" | null;
}

type State =
  | { s: "idle" }
  | { s: "running"; since: number }
  | { s: "done"; assumptions: string[]; questions: string[]; filled: number }
  | { s: "error"; message: string };

const POLL_MS = 2_000;
const GIVE_UP_MS = 4 * 60_000;

/** "Describe your goal": free text → the worker's intake agent → pre-fills the form below. Nothing is signed here. */
export function IntakeBox({ onApply }: { onApply: (f: IntakeFields) => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ s: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const submit = async () => {
    const t = text.trim();
    if (!t || state.s === "running") return;
    const since = Date.now();
    setState({ s: "running", since });
    try {
      const res = await fetch("/api/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
      const body = (await res.json().catch(() => ({}))) as { intake_id?: string; error?: string };
      if (!res.ok || !body.intake_id) {
        setState({ s: "error", message: res.status === 429 ? "Lots of people are asking right now. Try again in a minute, or fill the form below." : res.status === 503 ? "The assistant is offline. Fill the form below." : body.error ?? "Couldn't start. Fill the form below." });
        return;
      }
      const id = body.intake_id;
      const poll = async () => {
        if (Date.now() - since > GIVE_UP_MS) return setState({ s: "error", message: "That took too long. Fill the form below, or try again." });
        const r = await fetch(`/api/intake/${id}`).then((x) => x.json()).catch(() => null) as
          | { status?: string; fields?: IntakeFields; assumptions?: string[]; questions?: string[]; error?: string }
          | null;
        if (r?.status === "done" && r.fields) {
          onApply(r.fields);
          setState({ s: "done", assumptions: r.assumptions ?? [], questions: r.questions ?? [], filled: Object.values(r.fields).filter((v) => v !== null).length });
          return;
        }
        if (r?.status === "error") return setState({ s: "error", message: r.error ?? "The assistant couldn't read that. Fill the form below." });
        timer.current = setTimeout(poll, POLL_MS);
      };
      timer.current = setTimeout(poll, POLL_MS);
    } catch {
      setState({ s: "error", message: "Couldn't reach the assistant. Fill the form below." });
    }
  };

  return (
    <section aria-labelledby="intake-h" className="mb-6 grid gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <h2 id="intake-h" className="text-sm font-semibold">
          Describe your goal
        </h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">optional</span>
      </div>
      <Label htmlFor="intake-text" className="sr-only">
        Your goal in your own words
      </Label>
      <textarea
        id="intake-text"
        rows={3}
        maxLength={600}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
        placeholder="e.g. I'd like to buy about $300 of SOL if it drops to $110 in the next month"
        className="w-full resize-y rounded-xl border border-transparent bg-secondary px-3.5 py-3 text-base transition-colors duration-150 outline-none placeholder:text-muted-foreground focus-visible:border-input focus-visible:ring-2 focus-visible:ring-ring/40 md:text-sm"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="soft" className="h-9 rounded-full px-4" onClick={submit} disabled={!text.trim() || state.s === "running"}>
          {state.s === "running" ? "Reading…" : "Fill the form for me"}
        </Button>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {state.s === "running"
            ? "The assistant thinks carefully — usually under a minute."
            : "It only fills the form. You review everything before you sign."}
        </p>
      </div>
      {state.s === "error" && (
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}
      {state.s === "done" && (
        <div className={cn("relative grid gap-3 rounded-xl border border-primary/25 bg-accent p-4 text-[13px] text-accent-foreground [&_.text-muted-foreground]:text-accent-foreground/75")}>
          <button type="button" aria-label="Dismiss" onClick={() => setState({ s: "idle" })} className="absolute top-1 right-1 grid size-9 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <X className="size-4" aria-hidden />
          </button>
          <p className="font-medium">{state.filled ? `Filled ${state.filled} ${state.filled === 1 ? "answer" : "answers"} below. Check each one.` : "I couldn't fill anything — please use the form."}</p>
          {state.assumptions.length > 0 && (
            <div>
              <p className="text-muted-foreground">I assumed:</p>
              <ul className="mt-1 list-disc pl-5">
                {state.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {state.questions.length > 0 && (
            <div>
              <p className="text-muted-foreground">Still to decide (left empty below):</p>
              <ul className="mt-1 list-disc pl-5">
                {state.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
