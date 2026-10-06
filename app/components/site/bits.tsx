"use client";

import type { ReactNode } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { explorerAddress, explorerTx } from "@/lib/constants";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ExplorerLink({ sig, address, children, className }: { sig?: string; address?: string; children?: ReactNode; className?: string }) {
  const href = sig ? explorerTx(sig) : address ? explorerAddress(address) : "#";
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {children ?? <span className="font-mono text-xs">{shortAddr(sig ?? address)}</span>}
      <ExternalLink className="size-3.5" aria-hidden />
      <span className="sr-only">(opens explorer)</span>
    </a>
  );
}

export function Addr({ value, chars = 4 }: { value: string; chars?: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-xs" title={value}>
        {shortAddr(value, chars)}
      </span>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label="Copy address"
        onClick={() => {
          navigator.clipboard.writeText(value);
          toast.success("Copied");
        }}
      >
        <Copy className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-1.5">
      {eyebrow && <p className="text-xs font-medium text-primary">{eyebrow}</p>}
      <h1 className="font-display text-2xl leading-tight text-balance sm:text-[28px]">{title}</h1>
      {children && <div className="max-w-2xl text-sm text-pretty text-muted-foreground">{children}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
      {icon && <div className="text-muted-foreground [&_svg]:size-6">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-pretty text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}

export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="num text-lg font-semibold tracking-tight">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}
